// SPDX-License-Identifier: MIT
// wAGT v2 — мост с аварийной паузой и сменой выпускающего.
// Тестовые средства; аудита нет. Отличия от v1 (WAGT.sol):
//   - owner может сменить minter (ротация ключа выпуска) — событие MinterChanged;
//   - pauser может остановить/возобновить выпуск и сжигание — события Paused/Unpaused;
//   - пауза блокирует mint И burn (оба направления моста стоят);
//     балансы, уже выпущенные до паузы, не замораживаются (transfer работает),
//     заявки, поданные до паузы, обрабатываются только после снятия паузы.
// Роли: owner (смена minter/pauser), pauser (пауза), minter (только mint).
// Посторонний ключ не может сменить minter, снять паузу или выпустить токены.
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract WAGTv2 is ERC20 {
  address public owner;
  address public pauser;
  address public minter;
  bool public paused;
  mapping(bytes32 => bool) public mintedDeposit;

  event BridgeMint(address indexed to, uint256 amount, bytes32 indexed depositId, string agtTxid);
  event BridgeBurn(address indexed from, uint256 amount, string agtRecipient);
  event MinterChanged(address indexed oldMinter, address indexed newMinter);
  event PauserChanged(address indexed oldPauser, address indexed newPauser);
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

  constructor(address minter_, address pauser_) ERC20("Wrapped AGT (test v2)", "wAGT") {
    owner = msg.sender;
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
