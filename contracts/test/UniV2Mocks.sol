// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The smallest Uniswap V2 that SnoozeCurve.bond() can graduate into, so the suite can measure
/// graduation end to end without the real 2,000-line pair. What is kept is exactly what the
/// curve touches and what a later reader would check: createPair/getPair, mint() by balance
/// deltas with sqrt(k) liquidity, LP balances, getReserves. What is left out is swapping,
/// burning and the fee switch, none of which bond() calls. Not for deployment: the real ones
/// are on Base and web/checker.html lists them as verified.
interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

contract MockWETH {
    string public constant symbol = "WETH";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
}

contract MockV2Pair {
    address public token0;
    address public token1;
    uint112 private r0;
    uint112 private r1;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    uint256 public constant MINIMUM_LIQUIDITY = 1000;

    constructor(address a, address b) { (token0, token1) = a < b ? (a, b) : (b, a); }

    function getReserves() external view returns (uint112, uint112, uint32) { return (r0, r1, 0); }

    /// Liquidity from what ARRIVED since the last reserve update, exactly as the real pair
    /// does it — which is what lets a pre-seeded pair absorb a deposit without reverting.
    function mint(address to) external returns (uint256 liquidity) {
        uint256 b0 = IERC20Min(token0).balanceOf(address(this));
        uint256 b1 = IERC20Min(token1).balanceOf(address(this));
        uint256 a0 = b0 - r0;
        uint256 a1 = b1 - r1;
        if (totalSupply == 0) {
            liquidity = _sqrt(a0 * a1) - MINIMUM_LIQUIDITY;
            totalSupply += MINIMUM_LIQUIDITY;           // locked forever, as in the real one
        } else {
            uint256 l0 = (a0 * totalSupply) / r0;
            uint256 l1 = (a1 * totalSupply) / r1;
            liquidity = l0 < l1 ? l0 : l1;
        }
        require(liquidity > 0, "INSUFFICIENT_LIQUIDITY_MINTED");
        totalSupply += liquidity;
        balanceOf[to] += liquidity;
        // THE CHECK THIS MOCK WAS MISSING, and the reason a curve that could never graduate
        // passed every suite in this repository. A V2 reserve is uint112; the real
        // UniswapV2Pair._update opens with
        //     require(balance0 <= uint112(-1) && balance1 <= uint112(-1), 'UniswapV2: OVERFLOW')
        // and reverts. `r0 = uint112(b0)` is an EXPLICIT cast, which in Solidity 0.8 truncates
        // silently rather than reverting — so this mock banked a wrapped-around reserve and
        // reported success at exactly the amounts where Base would refuse. At 1e35 base units
        // of supply with 80% through the curve, bond() feeds the pair 1.85e34 against a
        // ceiling of 5.19e33 and reverts, permanently, with the whole raise inside the curve.
        require(b0 <= type(uint112).max && b1 <= type(uint112).max, "UniswapV2: OVERFLOW");
        r0 = uint112(b0); r1 = uint112(b1);
    }

    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) { z = y; uint256 x = y / 2 + 1; while (x < z) { z = x; x = (y / x + x) / 2; } }
        else if (y != 0) z = 1;
    }
}

contract MockV2Factory {
    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;
    function allPairsLength() external view returns (uint256) { return allPairs.length; }
    function createPair(address a, address b) external returns (address p) {
        require(a != b && getPair[a][b] == address(0), "PAIR_EXISTS");
        p = address(new MockV2Pair(a, b));
        getPair[a][b] = p; getPair[b][a] = p;
        allPairs.push(p);
    }
}
