const { ethers } = require("hardhat");

let deployer, user, oracle, usdc, dai, sdai, feedUSDC, feedWBTC, feedDAI, wbtc, MockERC20, Mock4626, MockAggregator;
const DAY = 24 * 60 * 60;

async function setup() {
    [deployer, user] = await ethers.getSigners();

    MockERC20 = await ethers.getContractFactory("MockERC20");
    Mock4626 = await ethers.getContractFactory("Mock4626");
    MockAggregator = await ethers.getContractFactory("MockAggregatorV3");

    const Oracle = await ethers.getContractFactory("UBKOracle");
    oracle = await Oracle.deploy(deployer.address);

    // Mock ERC20 tokens
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6, ethers.parseUnits("1000000", 6));
    dai = await MockERC20.deploy("DAI Stablecoin", "DAI", 18, ethers.parseUnits("1000000", 18));
    wbtc = await MockERC20.deploy("WBTC", "WBTC", 8, ethers.parseUnits("1000000", 8));

    feedUSDC = await MockAggregator.deploy(1e8, 8); // $1.00
    feedDAI = await MockAggregator.deploy(1e8, 8); // $1.00
    feedWBTC = await MockAggregator.deploy(25000e8, 8); // $25,000

    // Mock ERC4626 oracle (sDAI)
    const mockRate = ethers.parseUnits("1.02", 18); // simulate 2% yield
    sdai = await Mock4626.deploy("Savings DAI", "sDAI", 18, ethers.parseUnits("1000000", 18), dai.target);
    await sdai.setExchangeRate(mockRate);

    // Mock Chainlink feed (8 decimals)
    feed = await MockAggregator.deploy(1e8, 8); // $1.00

    await oracle.setStalePeriod(usdc.target, DAY);
    await oracle.setStalePeriod(dai.target, DAY);
    await oracle.setStalePeriod(wbtc.target, DAY);
    await oracle.setStalePeriod(sdai.target, DAY);

}

async function fixture() {
    await setup();
    return {
        deployer, user, oracle, usdc, dai, sdai, feedUSDC, feedWBTC, feedDAI, wbtc, MockERC20, Mock4626, MockAggregator, DAY
    }
}

module.exports = {
    fixture
};
