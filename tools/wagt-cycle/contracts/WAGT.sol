// SPDX-License-Identifier: MIT
// wAGT — тестовый wrapped-AGT. Выпуск 1:1 к заблокированным AGT выполняет
// только bridge-адрес (релейер). Повтор одного depositId отклоняется
// контрактом (deposit_replayed) — второй рубеж после реестра релейера.
// Тестовые средства; аудита нет.
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract WAGT is ERC20 {
  address public bridge;
  mapping(bytes32 => bool) public mintedDeposit;

  event BridgeMint(address indexed to, uint256 amount, bytes32 indexed depositId, string agtTxid);
  event BridgeBurn(address indexed from, uint256 amount, string agtRecipient);

  constructor(address bridge_) ERC20("Wrapped AGT (test)", "wAGT") {
    bridge = bridge_;
  }

  modifier onlyBridge() {
    require(msg.sender == bridge, "not_bridge");
    _;
  }

  function mint(address to, uint256 amount, bytes32 depositId, string calldata agtTxid)
    external
    onlyBridge
  {
    require(!mintedDeposit[depositId], "deposit_replayed");
    mintedDeposit[depositId] = true;
    _mint(to, amount);
    emit BridgeMint(to, amount, depositId, agtTxid);
  }

  function burn(uint256 amount, string calldata agtRecipient) external {
    _burn(msg.sender, amount);
    emit BridgeBurn(msg.sender, amount, agtRecipient);
  }
}
