// SPDX-License-Identifier: MIT
// BridgeGateway — федеративный шлюз выпуска wAGT, стенд v1 (Sepolia).
// Неизменяемый контракт (без прокси): смена логики — только новым развёртыванием.
// Опасные параметры (подписанты, порог) — двухшагово с задержкой; пауза — мгновенно,
// но пауза не меняет получателей и не конфискует средства.
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IWrappedAGT {
    function mint(address to, uint256 amount) external;
}

contract BridgeGateway is AccessControl {
    using ECDSA for bytes32;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @dev Канонический домен подписанного сообщения. Версия протокола — внутри.
    bytes32 public constant BRIDGE_ID = keccak256("AGT-WAGT-BRIDGE-V1");
    uint256 public constant PROTOCOL_VERSION = 1;

    IWrappedAGT public immutable wag;
    uint256 public immutable agentcoinChainId; // строковый id исходной цепи в eventId; число-якорь здесь
    uint256 public immutable dstChainId;       // сеть этого развёртывания (проверяется on-chain)

    uint256 public constant MIN_DELAY = 2 days;

    uint256 public threshold;
    address[] public signers;
    mapping(address => bool) public isSigner;

    uint256 public maxMintPerOp;
    uint256 public windowVolumeCap; // на 24ч, скользящее по суткам (UTC day buckets)
    uint256 public netOutstandingCap; // потолок чистого обращения (minted - burned)
    mapping(uint256 => uint256) public mintedPerDay;
    uint256 public totalMinted;
    uint256 public totalBurnedObserved; // вносит оператор-релеер по доказанным Burn (только учёт для cap)

    mapping(bytes32 => bool) public executed;

    bool public mintPaused;

    struct PendingSet {
        address[] signers;
        uint256 threshold;
        uint64 applyAfter;
        bool exists;
    }
    PendingSet public pending;

    error MintPaused();
    error AlreadyExecuted(bytes32 eventId);
    error BadArray();
    error NotSigner(address s);
    error DuplicateSigner(address s);
    error ThresholdNotMet(uint256 got, uint256 need);
    error OverPerOpLimit(uint256 amount, uint256 max);
    error OverWindowCap();
    error OverNetCap();
    error WrongChain(uint256 got, uint256 want);
    error NoPending();
    error DelayNotPassed(uint64 now_, uint64 applyAt);
    error BadThreshold();

    event MintAttested(bytes32 indexed eventId, address indexed to, uint256 amount);
    event SignersProposed(address[] signers, uint256 threshold, uint64 applyAfter);
    event SignersApplied(address[] signers, uint256 threshold);
    event LimitsSet(uint256 maxMintPerOp, uint256 windowVolumeCap, uint256 netOutstandingCap);
    event MintPauseSet(bool paused);
    event BurnObserved(bytes32 indexed burnRef, uint256 amount);

    constructor(
        address admin,
        address pauser,
        IWrappedAGT wag_,
        uint256 agentcoinChainId_,
        address[] memory initialSigners,
        uint256 threshold_,
        uint256 maxMintPerOp_,
        uint256 windowVolumeCap_,
        uint256 netOutstandingCap_
    ) {
        if (initialSigners.length == 0 || threshold_ == 0 || threshold_ > initialSigners.length)
            revert BadThreshold();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, pauser);
        wag = wag_;
        agentcoinChainId = agentcoinChainId_;
        dstChainId = block.chainid;
        _setSigners(initialSigners, threshold_);
        maxMintPerOp = maxMintPerOp_;
        windowVolumeCap = windowVolumeCap_;
        netOutstandingCap = netOutstandingCap_;
    }

    /// @notice Каноническое сообщение аттестации. Привязка: версия, мост, направление,
    /// сети, этот контракт, токен, eventId, получатель, сумма.
    /// Подписанты подписывают ВНУТРЕННИЙ хеш обычным signMessage (EIP-191 префикс
    /// добавляет кошелёк); контракт сверяет через attestationDigest (префикс внутри).
    function attestationInner(bytes32 eventId, address to, uint256 amountWei) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                PROTOCOL_VERSION,
                BRIDGE_ID,
                bytes32("AGT-LOCK->MINT"),
                agentcoinChainId,
                dstChainId,
                address(this),
                address(wag),
                eventId,
                to,
                amountWei
            )
        );
    }

    function attestationDigest(bytes32 eventId, address to, uint256 amountWei) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(attestationInner(eventId, to, amountWei));
    }

    /// @notice Выпуск wAGT по кворуму аттестаций. Идемпотентен по eventId.
    function mintAttested(bytes32 eventId, address to, uint256 amountWei, bytes[] calldata sigs) external {
        if (mintPaused) revert MintPaused();
        if (block.chainid != dstChainId) revert WrongChain(block.chainid, dstChainId);
        if (executed[eventId]) revert AlreadyExecuted(eventId);
        if (to == address(0) || amountWei == 0) revert BadArray();
        if (amountWei > maxMintPerOp) revert OverPerOpLimit(amountWei, maxMintPerOp);
        uint256 day = block.timestamp / 1 days;
        if (mintedPerDay[day] + amountWei > windowVolumeCap) revert OverWindowCap();
        if (totalMinted + amountWei - totalBurnedObserved > netOutstandingCap) revert OverNetCap();

        bytes32 d = attestationDigest(eventId, to, amountWei);
        uint256 okCount = 0;
        // уникальность: O(n^2) при n<=7 приемлемо и не требует памяти-массивов
        for (uint256 i = 0; i < sigs.length; i++) {
            address s = d.recover(sigs[i]);
            if (!isSigner[s]) revert NotSigner(s);
            for (uint256 j = 0; j < i; j++) {
                if (d.recover(sigs[j]) == s) revert DuplicateSigner(s);
            }
            okCount++;
            if (okCount >= threshold) break;
        }
        if (okCount < threshold) revert ThresholdNotMet(okCount, threshold);

        executed[eventId] = true; // effects-first: повторный вход/повторная доставка безопасны
        mintedPerDay[day] += amountWei;
        totalMinted += amountWei;
        wag.mint(to, amountWei);
        emit MintAttested(eventId, to, amountWei);
    }

    /// @notice Учёт доказанных Burn для потолка чистого обращения. Только admin-релеер.
    /// Не выпускает и не разблокирует ничего; лишь счётчик.
    function observeBurn(bytes32 burnRef, uint256 amountWei) external onlyRole(DEFAULT_ADMIN_ROLE) {
        totalBurnedObserved += amountWei;
        emit BurnObserved(burnRef, amountWei);
    }

    // --- управление: опасное — двухшагово с задержкой, пауза — мгновенно ---
    function proposeSigners(address[] calldata s, uint256 t) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (s.length == 0 || t == 0 || t > s.length) revert BadThreshold();
        for (uint256 i = 0; i < s.length; i++) {
            if (s[i] == address(0)) revert BadArray();
            for (uint256 j = 0; j < i; j++) if (s[j] == s[i]) revert DuplicateSigner(s[i]);
        }
        delete pending.signers;
        pending.signers = s;
        pending.threshold = t;
        pending.applyAfter = uint64(block.timestamp + MIN_DELAY);
        pending.exists = true;
        emit SignersProposed(s, t, pending.applyAfter);
    }

    function applySigners() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!pending.exists) revert NoPending();
        if (block.timestamp < pending.applyAfter) revert DelayNotPassed(uint64(block.timestamp), pending.applyAfter);
        _setSigners(pending.signers, pending.threshold);
        delete pending.signers;
        pending.exists = false;
        emit SignersApplied(signers, threshold);
    }

    function _setSigners(address[] memory s, uint256 t) internal {
        for (uint256 i = 0; i < signers.length; i++) delete isSigner[signers[i]];
        delete signers;
        for (uint256 i = 0; i < s.length; i++) {
            signers.push(s[i]);
            isSigner[s[i]] = true;
        }
        threshold = t;
    }

    function setLimits(uint256 maxOp, uint256 winCap, uint256 netCap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxMintPerOp = maxOp;
        windowVolumeCap = winCap;
        netOutstandingCap = netCap;
        emit LimitsSet(maxOp, winCap, netCap);
    }

    function setMintPaused(bool p) external onlyRole(PAUSER_ROLE) {
        mintPaused = p;
        emit MintPauseSet(p);
    }

    function signerCount() external view returns (uint256) {
        return signers.length;
    }
}
