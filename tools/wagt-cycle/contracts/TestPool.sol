// SPDX-License-Identifier: MIT
// TestPool — минимальный тестовый пул wAGT/tAGT. Математика повторяет
// Uniswap V2 (офиц.: x*y=k, комиссия 0.3% — getAmountOut с 997/1000;
// первый mint: sqrt(a0*a1) − MINIMUM_LIQUIDITY, минимум навсегда на нулевом
// адресе; burn — пропорциональный вывод). См. Uniswap v2-core UniswapV2Pair,
// whitepaper раздел 3.3. Router/FeeTo/оракулы опущены сознательно.
// Тестовые средства; аудита нет.
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract TestPool {
  IERC20 public immutable token0; // wAGT
  IERC20 public immutable token1; // tAGT
  uint256 public reserve0;
  uint256 public reserve1;
  uint256 public totalShares;
  mapping(address => uint256) public shares;
  uint256 public constant MINIMUM_LIQUIDITY = 1000;

  event LiquidityAdded(address indexed by, uint256 a0, uint256 a1, uint256 sharesMinted);
  event LiquidityRemoved(address indexed by, uint256 a0, uint256 a1, uint256 sharesBurned);
  event Swapped(address indexed by, address indexed tokenIn, uint256 amountIn, uint256 amountOut);

  constructor(address token0_, address token1_) {
    token0 = IERC20(token0_);
    token1 = IERC20(token1_);
  }

  function _sqrt(uint256 y) internal pure returns (uint256 z) {
    if (y > 3) {
      z = y;
      uint256 x = y / 2 + 1;
      while (x < z) {
        z = x;
        x = (y / x + x) / 2;
      }
    } else if (y != 0) {
      z = 1;
    }
  }

  function addLiquidity(uint256 a0, uint256 a1) external returns (uint256 minted) {
    require(a0 > 0 && a1 > 0, "zero_liquidity");
    token0.transferFrom(msg.sender, address(this), a0);
    token1.transferFrom(msg.sender, address(this), a1);
    if (totalShares == 0) {
      minted = _sqrt(a0 * a1) - MINIMUM_LIQUIDITY;
      shares[address(0)] = MINIMUM_LIQUIDITY;
      totalShares = MINIMUM_LIQUIDITY;
    } else {
      uint256 s0 = (a0 * totalShares) / reserve0;
      uint256 s1 = (a1 * totalShares) / reserve1;
      minted = s0 < s1 ? s0 : s1;
    }
    require(minted > 0, "dust");
    shares[msg.sender] += minted;
    totalShares += minted;
    reserve0 += a0;
    reserve1 += a1;
    emit LiquidityAdded(msg.sender, a0, a1, minted);
  }

  // Uniswap V2 getAmountOut: amountIn*997*reserveOut / (reserveIn*1000 + amountIn*997)
  function quoteOut(uint256 reserveIn, uint256 reserveOut, uint256 amountIn)
    public
    pure
    returns (uint256)
  {
    require(reserveIn > 0 && reserveOut > 0, "empty_pool");
    uint256 inWithFee = amountIn * 997;
    return (inWithFee * reserveOut) / (reserveIn * 1000 + inWithFee);
  }

  function swapExactIn(address tokenIn, uint256 amountIn, uint256 minOut, address to)
    external
    returns (uint256 amountOut)
  {
    require(tokenIn == address(token0) || tokenIn == address(token1), "bad_token");
    require(amountIn > 0, "zero_in");
    bool zeroForOne = tokenIn == address(token0);
    (uint256 rIn, uint256 rOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
    amountOut = quoteOut(rIn, rOut, amountIn);
    require(amountOut >= minOut && amountOut < rOut, "slip");
    IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
    (zeroForOne ? token1 : token0).transfer(to, amountOut);
    // Инвариант V2: произведение резервов после обмена не уменьшается.
    uint256 b0 = token0.balanceOf(address(this));
    uint256 b1 = token1.balanceOf(address(this));
    require(b0 * b1 >= reserve0 * reserve1, "k_broken");
    reserve0 = b0;
    reserve1 = b1;
    emit Swapped(msg.sender, tokenIn, amountIn, amountOut);
  }

  function removeLiquidity(uint256 burnShares) external returns (uint256 a0, uint256 a1) {
    require(burnShares > 0 && burnShares <= shares[msg.sender], "bad_shares");
    a0 = (burnShares * reserve0) / totalShares;
    a1 = (burnShares * reserve1) / totalShares;
    shares[msg.sender] -= burnShares;
    totalShares -= burnShares;
    reserve0 -= a0;
    reserve1 -= a1;
    token0.transfer(msg.sender, a0);
    token1.transfer(msg.sender, a1);
    emit LiquidityRemoved(msg.sender, a0, a1, burnShares);
  }
}
