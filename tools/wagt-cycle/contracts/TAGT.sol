// SPDX-License-Identifier: MIT
// tAGT — тестовый контр-токен для пула (аналог тестового USDC/казначейской
// валюты). Свободный faucet-mint: только для локального стенда.
// Тестовые средства; аудита нет.
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TAGT is ERC20 {
  constructor() ERC20("Test counterparty (test)", "tAGT") {}

  function faucet(address to, uint256 amount) external {
    _mint(to, amount);
  }
}
