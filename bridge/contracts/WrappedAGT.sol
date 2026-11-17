// SPDX-License-Identifier: MIT
// WrappedAGT (wAGT) — обеспеченный токен Agentcoin в EVM-сети, стенд v1.
// 1 wAGT = 1 AGT = 1e9 магнет. Минимальная неделимая единица wAGT для моста —
// 1e9 wei (= 1 магнет): некратные суммы мост не принимает (см. BurnAmountNotMagentExact).
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice wAGT. Выпуск — только через BridgeGateway (GATEWAY_ROLE).
/// Сжигание для обратного перевода — только через burnWithRecipient с регистрацией
/// получателя в Agentcoin; других способов «заказать» релиз у моста нет.
contract WrappedAGT is ERC20, AccessControl {
    bytes32 public constant GATEWAY_ROLE = keccak256("GATEWAY_ROLE");

    /// @dev 1 магнет в wei wAGT: 1e-9 AGT == 1e9 wei. Суммы burn обязаны быть кратны.
    uint256 public constant WEI_PER_MAGNET = 1e9;

    error BurnAmountNotMagentExact(uint256 amount);
    error BadRecipient();

    // Идентичность события сжигания — вне контракта: (chainId, txHash, logIndex).
    // eventId для моста строят аттесторы канонически, см. bridge-proto.mjs.
    event BurnRegistered(address indexed burner, uint256 amount, string agentcoinRecipient);

    constructor(address admin) ERC20("Wrapped AGT", "wAGT") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Выпуск обеспеченных wAGT. Только мост (GATEWAY_ROLE). Owner-mint отсутствует.
    function mint(address to, uint256 amount) external onlyRole(GATEWAY_ROLE) {
        _mint(to, amount);
    }

    /// @notice Сжигание для обратного перевода. Атомарно фиксирует получателя в Agentcoin.
    /// @param agentcoinRecipient Полный адрес AGT (с чек-суммой, без сокращений).
    function burnWithRecipient(uint256 amount, string calldata agentcoinRecipient) external {
        if (amount == 0 || amount % WEI_PER_MAGNET != 0) revert BurnAmountNotMagentExact(amount);
        bytes memory rcpt = bytes(agentcoinRecipient);
        if (rcpt.length < 10 || rcpt.length > 64) revert BadRecipient();
        _burn(_msgSender(), amount);
        emit BurnRegistered(_msgSender(), amount, agentcoinRecipient);
    }
}
