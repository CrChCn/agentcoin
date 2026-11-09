// SPDX-License-Identifier: MIT
// wAGT v2 — мост с аварийной паузой, сменой выпускающего и передачей владения.
// Тестовые средства; аудита нет. Отличия от v1 (WAGT.sol):
//   - owner может сменить minter (ротация ключа выпуска) — событие MinterChanged;
//   - pauser может остановить/возобновить выпуск и сжигание — события Paused/Unpaused;
//   - пауза блокирует mint И burn (оба направления моста стоят);
//     балансы, уже выпущенные до паузы, не замораживаются (transfer работает),
//     заявки, поданные до паузы, обрабатываются только после снятия паузы;
//   - владелец назначается ПРИ РАЗВЁРТЫВАНИИ (параметр owner_: в проде —
//     адрес мультисига; деплоер без owner_ никаких прав не получает) и может
//     передаваться только в два шага: transferOwnership + acceptOwnership
//     (защита от опечатки в адресе; нулевой адрес отклоняется).
// Роли: owner (смена minter/pauser, запуск/приём передачи владения),
//        pauser (ТОЛЬКО он ставит и снимает паузу), minter (только mint).
// Посторонний ключ не может сменить minter/pauser/owner, снять паузу
// или выпустить токены. Старый minter после ротации теряет право выпуска.
// Лимитов в контракте НЕТ: лимиты выпуска/возврата действуют только
// в релейере (см. BRIDGE-OPS.md § «Лимиты»); контракт их не знает и не проверяет.
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract WAGTv2 is ERC20 {
  address public owner;
  address public pendingOwner;
  address public pauser;
  address public minter;
  bool public paused;
  mapping(bytes32 => bool) public mintedDeposit;

  event BridgeMint(address indexed to, uint256 amount, bytes32 indexed depositId, string agtTxid);
  event BridgeBurn(address indexed from, uint256 amount, string agtRecipient);
  event MinterChanged(address indexed oldMinter, address indexed newMinter);
  event PauserChanged(address indexed oldPauser, address indexed newPauser);
  event OwnershipTransferStarted(address indexed oldOwner, address indexed newOwner);
  event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
  event Paused(address indexed by);
  event Unpaused(address indexed by);

  modifier onlyOwner() {
    require(msg.sender == owner, "not_owner");
    _;
  }

  modifier onlyPauser() {
    require(msg.sender == pauser, "not_pauser");
    _;
  }

  modifier onlyMinter() {
    require(msg.sender == minter, "not_minter");
    _;
  }

  modifier whenNotPaused() {
    require(!paused, "bridge_paused");
    _;
  }

  constructor(address owner_, address minter_, address pauser_) ERC20("Wrapped AGT (test v2)", "wAGT") {
    require(owner_ != address(0), "zero_owner");
    require(minter_ != address(0), "zero_minter");
    require(pauser_ != address(0), "zero_pauser");
    owner = owner_;
    minter = minter_;
    pauser = pauser_;
  }

  function setMinter(address newMinter) external onlyOwner {
    require(newMinter != address(0), "zero_minter");
    emit MinterChanged(minter, newMinter);
    minter = newMinter;
  }

  function setPauser(address newPauser) external onlyOwner {
    require(newPauser != address(0), "zero_pauser");
    emit PauserChanged(pauser, newPauser);
    pauser = newPauser;
  }

  /// Шаг 1 передачи владения: только текущий owner; нулевой адрес отклоняется.
  function transferOwnership(address newOwner) external onlyOwner {
    require(newOwner != address(0), "zero_owner");
    pendingOwner = newOwner;
    emit OwnershipTransferStarted(owner, newOwner);
  }

  /// Шаг 2: принимает только назначенный адрес; без accept права не переходят.
  function acceptOwnership() external {
    require(msg.sender == pendingOwner, "not_pending_owner");
    emit OwnershipTransferred(owner, pendingOwner);
    owner = pendingOwner;
    pendingOwner = address(0);
  }

  function pause() external onlyPauser {
    paused = true;
    emit Paused(msg.sender);
  }

  function unpause() external onlyPauser {
    paused = false;
    emit Unpaused(msg.sender);
  }

  function mint(address to, uint256 amount, bytes32 depositId, string calldata agtTxid)
    external
    onlyMinter
    whenNotPaused
  {
    require(!mintedDeposit[depositId], "deposit_replayed");
    mintedDeposit[depositId] = true;
    _mint(to, amount);
    emit BridgeMint(to, amount, depositId, agtTxid);
  }

  function burn(uint256 amount, string calldata agtRecipient) external whenNotPaused {
    _burn(msg.sender, amount);
    emit BridgeBurn(msg.sender, amount, agtRecipient);
  }
}
