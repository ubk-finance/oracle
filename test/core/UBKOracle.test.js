const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

let deployer, user, oracle, usdc, dai, sdai, feedUSDC, feedWBTC, feedDAI, wbtc, MockERC20, Mock4626, MockAggregator;
const DAY = 24 * 60 * 60;

async function setup() {
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

describe("UBKOracle", function () {
  before(async () => {
    [deployer, user] = await ethers.getSigners();
    MockERC20 = await ethers.getContractFactory("MockERC20");
    Mock4626 = await ethers.getContractFactory("Mock4626");
    MockAggregator = await ethers.getContractFactory("MockAggregatorV3");

  });

  beforeEach(async () => {
    await setup();
  });

  // --- Constructor ---
  describe("Constructor", function () {
    it("should revert if owner is zero address (via Ownable)", async () => {
      const Oracle = await ethers.getContractFactory("UBKOracle");
      await expect(Oracle.deploy(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(Oracle, "OwnableInvalidOwner");
    });
  });

  describe("Admin", function () {
    // --- setChainlinkFeed ---
    describe("setChainlinkFeed", function () {
      it("should allow owner to set feed", async () => {
        await expect(oracle.connect(deployer).setChainlinkFeed(usdc.target, feed.target))
          .to.emit(oracle, "ChainlinkFeedSet")
          .withArgs(usdc.target, feed.target);

        expect(await oracle.chainlinkFeeds(usdc.target)).to.equal(feed.target);
      });

      it("should reset manual mode when feed is set", async () => {
        await oracle.setManualPrice(usdc.target, ethers.parseUnits("2", 18));
        expect(await oracle.isManual(usdc.target)).to.be.true;

        await oracle.setChainlinkFeed(usdc.target, feed.target);
        expect(await oracle.isManual(usdc.target)).to.be.false;
      });

      it("should emit TokenSupportAdded and register token in supportedTokens", async () => {
        const tx = await oracle.setChainlinkFeed(usdc.target, feed.target);

        await expect(tx)
          .to.emit(oracle, "TokenSupportAdded")
          .withArgs(usdc.target);

        // mapping should reflect support
        expect(await oracle.isSupported(usdc.target)).to.be.true;

        // array should include token
        const tokens = await oracle.getSupportedTokens();
        expect(tokens).to.include(usdc.target);
      });

      it("should not emit TokenSupportAdded again for the same token", async () => {
        await oracle.setChainlinkFeed(usdc.target, feed.target); // first registration
        const tx = await oracle.setChainlinkFeed(usdc.target, feed.target);  // second registration

        // no new TokenSupportAdded event
        await expect(tx).to.not.emit(oracle, "TokenSupportAdded");

        // array length should remain 1
        const tokens = await oracle.getSupportedTokens();
        expect(tokens.length).to.equal(1);
        expect(tokens[0]).to.equal(usdc.target);
      });

      it("should revert if token is zero", async () => {
        await expect(oracle.setChainlinkFeed(ethers.ZeroAddress, feed.target))
          .to.be.revertedWithCustomError(oracle, "ZeroAddress");
      });

      it("should revert if feed is zero", async () => {
        await expect(oracle.setChainlinkFeed(usdc.target, ethers.ZeroAddress))
          .to.be.revertedWithCustomError(oracle, "ZeroAddress");
      });

      it("should not allow non-owner to set feed", async () => {
        await expect(oracle.connect(user).setChainlinkFeed(usdc.target, feed.target))
          .to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
      });

      it("reverts if feed decimals > 18", async () => {
        const BadFeed = await ethers.getContractFactory("MockAggregatorV3");
        const badFeed = await BadFeed.deploy(1e8, 19); // 19 decimals → invalid

        await expect(
          oracle.setChainlinkFeed(usdc.target, badFeed.target)
        ).to.be.revertedWithCustomError(oracle, "InvalidFeedDecimals");
      });

      it("treats a negative Chainlink answer as invalid and falls back", async () => {
        // 1. Seed oracle with a valid cached price
        await oracle.setChainlinkFeed(usdc.target, feedUSDC.target);
        await oracle["fetchAndUpdatePrice(address)"](usdc.target);
        const cached = await oracle.getPrice(usdc.target);

        // 2. Make Chainlink return a negative answer
        await feedUSDC.updateAnswer(-100_000_000); // e.g. -1.0 * 1e8

        // 3. fetchAndUpdatePrice() should fall back to cached value
        await expect(oracle["fetchAndUpdatePrice(address)"](usdc.target))
          .to.emit(oracle, "OracleFallbackUsed")
          .withArgs(usdc.target, cached, anyValue, "Chainlink failure");

        // 4. Ensure cached value remains in place
        const finalPrice = await oracle.getPrice(usdc.target);
        expect(finalPrice).to.equal(cached);
      });
    });

    // --- setERC4626Vault ---
    describe("setERC4626Vault", function () {
      it("should register oracle and underlying", async () => {
        await expect(oracle.setERC4626Vault(sdai.target, dai.target))
          .to.emit(oracle, "ERC4626Registered")
          .withArgs(sdai.target, dai.target);

        expect(await oracle.erc4626Underlying(sdai.target)).to.equal(dai.target);
      });

      it("should emit TokenSupportAdded and update mappings", async () => {
        const tx = await oracle.setERC4626Vault(sdai.target, dai.target);

        await expect(tx)
          .to.emit(oracle, "TokenSupportAdded")
          .withArgs(sdai.target);

        // mapping should reflect token support
        expect(await oracle.isSupported(sdai.target)).to.be.true;

        // array should include the new token
        const tokens = await oracle.getSupportedTokens();
        expect(tokens).to.include(sdai.target);
      });

      it("should not emit TokenSupportAdded twice for same oracle", async () => {
        await oracle.setERC4626Vault(sdai.target, dai.target);
        const tx = await oracle.setERC4626Vault(sdai.target, dai.target);

        await expect(tx).to.not.emit(oracle, "TokenSupportAdded");

        const tokens = await oracle.getSupportedTokens();
        expect(tokens.length).to.equal(1);
        expect(tokens[0]).to.equal(sdai.target);
      });

      it("should revert if oracle is zero", async () => {
        await expect(oracle.setERC4626Vault(ethers.ZeroAddress, dai.target))
          .to.be.revertedWithCustomError(oracle, "ZeroAddress");
      });

      it("should revert if underlying is zero", async () => {
        await expect(oracle.setERC4626Vault(sdai.target, ethers.ZeroAddress))
          .to.be.revertedWithCustomError(oracle, "ZeroAddress");
      });

      it("should revert if oracle is not a valid ERC4626 contract", async () => {
        // deploy a contract that does NOT implement asset()
        const Invalidoracle = await ethers.getContractFactory("MockERC20");
        const badoracle = await Invalidoracle.deploy(
          "Fakeoracle",
          "FV",
          18,
          ethers.parseUnits("1000000", 18)
        );

        // calling setERC4626Vault should revert
        await expect(
          oracle.setERC4626Vault(badoracle.target, dai.target)
        ).to.be.revertedWithCustomError(oracle, "InvalidERC4626Vault");
      });

      it("should not allow non-owner to call", async () => {
        await expect(oracle.connect(user).setERC4626Vault(sdai.target, dai.target))
          .to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
      });

      it("reverts with SuspiciousVaultRate when rate < default min bound", async () => {
        await oracle.setERC4626Vault(sdai.target, dai.target);
        await oracle.setChainlinkFeed(dai.target, feedDAI.target);

        // force convertToAssets to return 0 → invalid
        await sdai.setExchangeRate(0);

        await expect(
          oracle["fetchAndUpdatePrice(address)"](sdai.target)
        ).to.be.revertedWithCustomError(oracle, "InvalidVaultExchangeRate");
      });

      it("reverts with SuspiciousVaultRate when rate > max bound", async () => {
        await oracle.setERC4626Vault(sdai.target, dai.target);
        await oracle.setChainlinkFeed(dai.target, feedDAI.target);

        // artificially huge exchange rate
        await sdai.setExchangeRate(ethers.parseUnits("1000", 18)); // insane APY

        await expect(
          oracle["fetchAndUpdatePrice(address)"](sdai.target)
        ).to.be.revertedWithCustomError(oracle, "SuspiciousVaultRate");
      });


    });

    describe("setManualPrice()", function () {
      it("should allow owner to set a manual price", async () => {
        const manualPrice = ethers.parseUnits("2", 18);

        await expect(oracle.setManualPrice(usdc.target, manualPrice))
          .to.emit(oracle, "ManualPriceSet")
          .withArgs(usdc.target, manualPrice);

        expect(await oracle.manualPrices(usdc.target)).to.equal(manualPrice);
        expect(await oracle.isManual(usdc.target)).to.be.true;
      });

      it("should emit ManualModeEnabled when enabling manual price mode", async () => {
        const manualPrice = ethers.parseUnits("5", 18);

        await expect(oracle.setManualPrice(usdc.target, manualPrice))
          .to.emit(oracle, "ManualModeEnabled")
          .withArgs(usdc.target, true);
      });

      it("should revert if token address is zero", async () => {
        await expect(
          oracle.setManualPrice(ethers.ZeroAddress, ethers.parseUnits("1", 18))
        ).to.be.revertedWithCustomError(oracle, "ZeroAddress");
      });

      it("should revert if price is zero", async () => {
        await expect(
          oracle.setManualPrice(usdc.target, 0)
        ).to.be.revertedWithCustomError(oracle, "InvalidManualPrice");
      });

      it("should overwrite existing manual price when called again", async () => {
        const firstPrice = ethers.parseUnits("1", 18);
        const newPrice = ethers.parseUnits("1.10", 18);

        await oracle.setManualPrice(usdc.target, firstPrice);
        await oracle.setManualPrice(usdc.target, newPrice);

        expect(await oracle.manualPrices(usdc.target)).to.equal(newPrice);
      });

      it("should revert if manual price deviates >10% from last valid price", async () => {
        await oracle.setChainlinkFeed(usdc.target, feed.target);
        await oracle["fetchAndUpdatePrice(address)"](usdc.target); // establishes baseline = $1
        const invalidHigh = ethers.parseUnits("1.20", 18); // +20%
        await expect(oracle.setManualPrice(usdc.target, invalidHigh))
          .to.be.revertedWithCustomError(oracle, "InvalidManualPrice");
      });

      it("should disable manual mode and emit event", async () => {
        await oracle.setManualPrice(usdc.target, ethers.parseUnits("2", 18));
        await expect(oracle.disableManualPrice(usdc.target))
          .to.emit(oracle, "ManualModeEnabled")
          .withArgs(usdc.target, false);
        expect(await oracle.isManual(usdc.target)).to.be.false;
      });

      describe("disableManualPrice()", function () {
        beforeEach(async () => {
          // Ensure manual mode is active before disabling
          await oracle.setManualPrice(usdc.target, ethers.parseUnits("1.00", 18));
          expect(await oracle.isManual(usdc.target)).to.be.true;
        });

        it("should allow owner to disable manual mode", async () => {
          await expect(oracle.disableManualPrice(usdc.target))
            .to.emit(oracle, "ManualModeEnabled")
            .withArgs(usdc.target, false);

          expect(await oracle.isManual(usdc.target)).to.be.false;
        });

        it("should disable manual mode and emit event", async () => {
          await oracle.setManualPrice(usdc.target, ethers.parseUnits("0.93", 18));
          await expect(oracle.disableManualPrice(usdc.target))
            .to.emit(oracle, "ManualModeEnabled")
            .withArgs(usdc.target, false);
          expect(await oracle.isManual(usdc.target)).to.be.false;
        });

        it("should still maintain the manual price mapping after disablement", async () => {
          await oracle.disableManualPrice(usdc.target);
          const price = await oracle.manualPrices(usdc.target);
          expect(price).to.equal(ethers.parseUnits("1.00", 18));
        });

        it("should revert if token is zero address", async () => {
          await expect(oracle.disableManualPrice(ethers.ZeroAddress))
            .to.be.revertedWithCustomError(oracle, "ZeroAddress");
        });

        it("should not allow non-owner to disable manual mode", async () => {
          await expect(oracle.connect(user).disableManualPrice(usdc.target))
            .to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
        });
      });

    });

    describe("setStalePeriod()", function () {
      it("should allow owner to update the stale period", async () => {
        const newPeriod = 7200; // 2 hours

        await expect(oracle.setStalePeriod(usdc.target, newPeriod)).
          to.emit(oracle, "StalePeriodUpdated")
          .withArgs(usdc.target, newPeriod);

        expect(await oracle.stalePeriod(usdc.target)).to.equal(newPeriod);
      });

      it("should overwrite stalePeriod if called multiple times", async () => {
        const firstPeriod = 3600;
        const secondPeriod = 3600 * 3;

        await oracle.setStalePeriod(usdc.target, firstPeriod);
        await oracle.setStalePeriod(usdc.target, secondPeriod);

        expect(await oracle.stalePeriod(usdc.target)).to.equal(secondPeriod);
      });

      it("should revert if non-owner tries to update stale period", async () => {
        await expect(
          oracle.connect(user).setStalePeriod(usdc.target, 9999)
        ).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
      });

      it("should revert if stalePeriod < 1h or > 3h", async () => {
        await expect(oracle.setStalePeriod(usdc.target, 3600 - 1))
          .to.be.revertedWithCustomError(oracle, "InvalidStalePeriod");
        await expect(oracle.setStalePeriod(usdc.target, DAY * 3))
          .to.be.revertedWithCustomError(oracle, "InvalidStalePeriod");
      });

      it("updates fallbackStalePeriod automatically when stalePeriod is updated", async () => {
        const stale = 7200; // 2 hours
        await oracle.setStalePeriod(usdc.target, stale);

        const fallback = await oracle.fallbackStalePeriod(usdc.target);
        expect(fallback).to.equal(stale * 2); // default multiplier = 2
      });

      it("maintains independent stalePeriod settings per token", async () => {
        await oracle.setStalePeriod(usdc.target, 3600);
        await oracle.setStalePeriod(dai.target, 7200);

        expect(await oracle.stalePeriod(usdc.target)).to.equal(3600);
        expect(await oracle.stalePeriod(dai.target)).to.equal(7200);

        expect(await oracle.fallbackStalePeriod(usdc.target)).to.equal(3600 * 2);
        expect(await oracle.fallbackStalePeriod(dai.target)).to.equal(7200 * 2);
      });

      it("manual price mode ignores stalePeriod and returns instantly", async () => {
        await oracle.setManualPrice(usdc.target, ethers.parseUnits("1.11", 18));

        // simulate huge time jump
        await ethers.provider.send("evm_increaseTime", [999999]);
        await ethers.provider.send("evm_mine");

        await oracle["fetchAndUpdatePrice(address)"](usdc.target).then(tx => tx.wait());

        const price = await oracle.getPrice(usdc.target);
        expect(price).to.equal(ethers.parseUnits("1.11", 18));
      });

      it("reverts immediately when first Chainlink read is stale and no fallback exists", async () => {
        await oracle.setChainlinkFeed(usdc.target, feedUSDC.target);

        const stale = 3600;
        await oracle.setStalePeriod(usdc.target, stale);

        // No initial fetchAndUpdatePrice → no cached fallback

        await feedUSDC.setUpdatedAt((await time.latest()) - (stale + 1));

        await expect(
          oracle["fetchAndUpdatePrice(address)"](usdc.target)
        ).to.be.revertedWithCustomError(oracle, "NoFallbackPrice");
      });
    });

    describe("setFallbackStalePeriod()", function () {
      it("should allow owner to set fallback stale period ≥ stalePeriod", async () => {
        const stale = 3600; // 1 hour
        const fallback = 5400; // 1.5 hours

        await oracle.setStalePeriod(usdc.target, stale);
        await expect(oracle.setFallbackStalePeriod(usdc.target, fallback))
          .to.emit(oracle, "FallbackStalePeriodUpdated")
          .withArgs(usdc.target, fallback);

        expect(await oracle.fallbackStalePeriod(usdc.target)).to.equal(fallback);
      });

      it("should revert if fallback period < stalePeriod", async () => {
        await oracle.setStalePeriod(usdc.target, 7200); // 2 hours
        await expect(oracle.setFallbackStalePeriod(usdc.target, 3600))
          .to.be.revertedWithCustomError(oracle, "InvalidStalePeriod");
      });

      it("enforces fallbackStalePeriod bounds", async () => {
        const stale = 3600;
        await oracle.setStalePeriod(usdc.target, stale);

        await expect(
          oracle.setFallbackStalePeriod(usdc.target, stale - 1)
        ).to.be.revertedWithCustomError(oracle, "InvalidStalePeriod");

        const tooHigh = stale * 3 + 1;
        await expect(
          oracle.setFallbackStalePeriod(usdc.target, tooHigh)
        ).to.be.revertedWithCustomError(oracle, "InvalidStalePeriod");

        // valid
        const valid = stale * 3;
        await oracle.setFallbackStalePeriod(usdc.target, valid);
        expect(await oracle.fallbackStalePeriod(usdc.target)).to.equal(valid);
      });

      it("should revert if called by non-owner", async () => {
        await expect(
          oracle.connect(user).setFallbackStalePeriod(usdc.target, 4000)
        ).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
      });
    });

    describe("setOracleMode()", function () {
      it("should allow owner to change mode from NORMAL to PAUSED", async () => {
        const PAUSED = 1; // enum OracleMode.PAUSED
        const NORMAL = 0;

        await expect(oracle.setOracleMode(PAUSED))
          .to.emit(oracle, "OracleModeChanged")
          .withArgs(NORMAL, PAUSED);

        expect(await oracle.mode()).to.equal(PAUSED);
      });

      it("should allow switching back from PAUSED to NORMAL", async () => {
        const PAUSED = 1;
        const NORMAL = 0;

        await oracle.setOracleMode(PAUSED);

        await expect(oracle.setOracleMode(NORMAL))
          .to.emit(oracle, "OracleModeChanged")
          .withArgs(PAUSED, NORMAL);

        expect(await oracle.mode()).to.equal(NORMAL);
      });

      it("should revert if called by non-owner", async () => {
        const PAUSED = 1;
        await expect(oracle.connect(user).setOracleMode(PAUSED))
          .to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount")
          .withArgs(user.address);
      });
    });

    describe("setVaultRateBounds()", function () {
      const min = ethers.parseUnits("0.5", 18);
      const max = ethers.parseUnits("2", 18);
      const defaultMin = ethers.parseUnits("0.2", 18); // from Constants.DEFAULT_MIN_oracle_RATE
      const defaultMax = ethers.parseUnits("3", 18);   // from Constants.DEFAULT_MAX_oracle_RATE

      it("should allow owner to set min and max bounds for a oracle", async () => {
        await expect(oracle.setVaultRateBounds(sdai.target, min, max))
          .to.emit(oracle, "VaultRateBoundsSet")
          .withArgs(sdai.target, min, max);

        const bounds = await oracle.vaultRateBounds(sdai.target);
        expect(bounds.minRate).to.equal(min);
        expect(bounds.maxRate).to.equal(max);
      });

      it("should revert if oracle is zero address", async () => {
        await expect(
          oracle.setVaultRateBounds(ethers.ZeroAddress, min, max)
        ).to.be.revertedWithCustomError(oracle, "ZeroAddress");
      });

      it("should revert if min is zero", async () => {
        await expect(
          oracle.setVaultRateBounds(sdai.target, 0, max)
        ).to.be.revertedWithCustomError(oracle, "InvalidVaultBounds");
      });

      it("should revert if max ≤ min", async () => {
        await expect(
          oracle.setVaultRateBounds(sdai.target, max, min)
        ).to.be.revertedWithCustomError(oracle, "InvalidVaultBounds");
      });

      it("should revert if max > 100e18", async () => {
        const hugeMax = ethers.parseUnits("101", 18); // exceeds hardcoded limit
        await expect(
          oracle.setVaultRateBounds(sdai.target, min, hugeMax)
        ).to.be.revertedWithCustomError(oracle, "InvalidVaultBounds");
      });

      it("should revert if called by non-owner", async () => {
        await expect(
          oracle.connect(user).setVaultRateBounds(sdai.target, min, max)
        ).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
      });

      it("should use default min/max bounds in _getoraclePrice() if none are set", async () => {
        // Only set ERC4626 mapping and feed for underlying
        await oracle.setERC4626Vault(sdai.target, dai.target);
        await oracle.setChainlinkFeed(dai.target, feed.target);

        // Now fetch and verify that the defaults are accepted (rate = 1.02)
        const tx = await oracle["fetchAndUpdatePrice(address)"](sdai.target);
        const receipt = await tx.wait();

        const price = await oracle.getPrice(sdai.target);
        expect(price).to.equal(ethers.parseUnits("1.02", 18));

        // Internally this passes: defaultMin = 0.2e18, defaultMax = 3e18
      });
    });
  })

  describe("External API", function () {
    beforeEach(async () => {
      await setup();
    });

    describe("fetchAndUpdatePrice()", function () {
      it("should return the manual price if manual mode is enabled", async () => {
        const manualPrice = ethers.parseUnits("1.23", 18);
        await oracle.setManualPrice(usdc.target, manualPrice);

        const tx = await oracle["fetchAndUpdatePrice(address)"](usdc.target);
        await tx.wait();

        const price = await oracle.getPrice(usdc.target);
        expect(price).to.equal(manualPrice);
      });

      it("should return the oracle-derived price if ERC4626 is configured", async () => {
        await oracle.setERC4626Vault(sdai.target, dai.target);
        await oracle.setChainlinkFeed(dai.target, feed.target); // DAI = $1

        const expected = ethers.parseUnits("1.02", 18); // from mocked oracle exchange rate

        const tx = await oracle["fetchAndUpdatePrice(address)"](sdai.target);
        await tx.wait();

        const price = await oracle.getPrice(sdai.target);
        expect(price).to.equal(expected);
      });

      it("should update lastValidPrice when fetchAndUpdatePrice is called", async () => {
        await oracle.setChainlinkFeed(usdc.target, feed.target);

        // Call fetchAndUpdatePrice()
        const tx = await oracle["fetchAndUpdatePrice(address)"](usdc.target);
        const receipt = await tx.wait();

        // --- verify return value ---
        const price = await oracle.getPrice(usdc.target);
        expect(price).to.equal(ethers.parseUnits("1", 18));

        // --- verify lastValidPrice updated ---
        const last = await oracle.lastValidPrice(usdc.target);
        expect(last.price).to.equal(price);
        expect(last.timestamp).to.be.gt(0);

        // --- verify event emitted ---
        await expect(oracle["fetchAndUpdatePrice(address)"](usdc.target))
          .to.emit(oracle, "LastValidPriceUpdated")
          .withArgs(usdc.target, ethers.parseUnits("1", 18), anyValue);
      });

      it("should return the Chainlink price and not revert if lastValidPrice exists", async () => {
        await oracle.setChainlinkFeed(usdc.target, feed.target); // returns 1e8 with 8 decimals
        const expected = ethers.parseUnits("1", 18);

        let tx = await oracle["fetchAndUpdatePrice(address)"](usdc.target);
        await tx.wait();

        price = await oracle.getPrice(usdc.target);
        expect(price).to.equal(expected);
      });

      it("should emit LastValidPriceUpdated", async () => {
        await oracle.setChainlinkFeed(usdc.target, feed.target);

        await expect(oracle["fetchAndUpdatePrice(address)"](usdc.target))
          .to.emit(oracle, "LastValidPriceUpdated")
          .withArgs(usdc.target, ethers.parseUnits("1", 18), anyValue);
      });

      it("should fallback to lastValidPrice if Chainlink data is stale", async () => {
        // Step 1: Get initial valid price
        await oracle.setChainlinkFeed(usdc.target, feed.target);
        await oracle["fetchAndUpdatePrice(address)"](usdc.target);
        const price1 = await oracle.getPrice(usdc.target);

        // Step 2: Get current blockchain timestamp
        const latestBlock = await ethers.provider.getBlock('latest');
        const currentTimestamp = latestBlock.timestamp;

        // Step 3: Deploy feed with stale updatedAt (beyond stalePeriod but within fallbackStalePeriod)
        const MockAggregator = await ethers.getContractFactory("MockAggregatorV3");
        const staleFeed = await MockAggregator.deploy(1e8, 8);

        // Set updatedAt to 2 hours ago (beyond default stalePeriod of 3600s)
        await staleFeed.setUpdatedAt(currentTimestamp - 7200 - 1);
        await oracle.setChainlinkFeed(usdc.target, staleFeed.target);

        // Step 4: Fetch should fallback gracefully and emit correct event (within fallbackStalePeriod)
        expect(await oracle["fetchAndUpdatePrice(address)"](usdc.target))
          .to.emit(oracle, "OracleFallbackUsed")
          .withArgs(usdc.target, price1, anyValue, "Chainlink failure");

        // Step 5: Should return original valid price
        const price2 = await oracle.getPrice(usdc.target);
        expect(price2).to.equal(price1);
      });

      it("should fallback to lastValidPrice if Chainlink returns invalid answer (not stale)", async () => {
        // Step 1: Set initial valid price
        await oracle.setChainlinkFeed(usdc.target, feed.target);
        await oracle["fetchAndUpdatePrice(address)"](usdc.target);
        const price1 = await oracle.getPrice(usdc.target);

        // Step 2: Simulate oracle attack - invalid answer but fresh timestamp
        await feed.updateAnswer(0); // Invalid price (0 or negative)

        // Step 3: Fetch should fallback gracefully and emit the correct event (feed is fresh but invalid)
        expect(await oracle["fetchAndUpdatePrice(address)"](usdc.target))
          .to.emit(oracle, "OracleFallbackUsed")
          .withArgs(usdc.target, price1, anyValue, "Chainlink failure");

        // Step 4: Should return original valid price (fallback)
        const price2 = await oracle.getPrice(usdc.target);
        expect(price2).to.equal(price1);

      });

      it("should revert if token is zero address", async () => {
        await expect(oracle["fetchAndUpdatePrice(address)"](ethers.ZeroAddress))
          .to.be.revertedWithCustomError(oracle, "ZeroAddress");
      });

      it("should revert if oracle is paused", async () => {
        await oracle.setOracleMode(1); // PAUSED enum value
        await expect(oracle["fetchAndUpdatePrice(address)"](usdc.target))
          .to.be.revertedWithCustomError(oracle, "OraclePaused");
      });

      it("reverts with StaleFallback when cached fallback is older than fallbackStalePeriod", async () => {
        await oracle.setChainlinkFeed(usdc.target, feedUSDC.target);
        await oracle["fetchAndUpdatePrice(address)"](usdc.target); // establish valid price
        const stale = 3600;

        await oracle.setStalePeriod(usdc.target, stale); // fallback = 2 * stale = 7200

        // make cached price too old → beyond fallbackStalePeriod
        await ethers.provider.send("evm_increaseTime", [7200 + 1]);
        await ethers.provider.send("evm_mine");

        // feed now stale + invalid
        await feedUSDC.setUpdatedAt((await time.latest()) - (stale + 1));

        await expect(
          oracle["fetchAndUpdatePrice(address)"](usdc.target)
        ).to.be.revertedWithCustomError(oracle, "StaleFallback");
      });
    });

    describe("getPrice()", function () {
      beforeEach(async () => {
        await setup();
        await oracle.setChainlinkFeed(usdc.target, feedUSDC.target);
        await oracle["fetchAndUpdatePrice(address)"](usdc.target);
      });

      it("reverts with StalePrice when lastValidPrice is older than stalePeriod", async () => {
        const stale = 3600;
        await oracle.setStalePeriod(usdc.target, stale);

        await ethers.provider.send("evm_increaseTime", [stale + 1]);
        await ethers.provider.send("evm_mine");

        await expect(oracle.getPrice(usdc.target))
          .to.be.revertedWithCustomError(oracle, "StalePrice");
      });
    });

    describe("toUSD() + fromUSD()", function () {
      it("correctly converts 6-decimal USDC to USD", async () => {
        await oracle.setChainlinkFeed(usdc.target, feedUSDC.target);
        await oracle["fetchAndUpdatePrice(address)"](usdc.target);

        const amount = ethers.parseUnits("123.456789", 6);
        const usd = await oracle.toUSD(usdc.target, amount);

        expect(usd).to.equal(ethers.parseUnits("123.456789", 18));
      });

      it("correctly converts 8-decimal WBTC to USD", async () => {
        await oracle.setChainlinkFeed(wbtc.target, feedWBTC.target);
        await oracle["fetchAndUpdatePrice(address)"](wbtc.target);

        const amount = ethers.parseUnits("1", 8);
        const usd = await oracle.toUSD(wbtc.target, amount);

        expect(usd).to.equal(ethers.parseUnits("25000", 18));
      });

      it("correctly handles mixed decimals (sDAI + USDC + WBTC)", async () => {
        await oracle.setChainlinkFeed(usdc.target, feedUSDC.target); // 6d
        await oracle.setChainlinkFeed(dai.target, feedUSDC.target); // 6d
        await oracle.setChainlinkFeed(wbtc.target, feedWBTC.target); // 8d

        await oracle.setERC4626Vault(sdai.target, dai.target); // 18d

        await oracle["fetchAndUpdatePrice(address)"](sdai.target);
        await oracle["fetchAndUpdatePrice(address)"](dai.target);
        await oracle["fetchAndUpdatePrice(address)"](usdc.target);
        await oracle["fetchAndUpdatePrice(address)"](wbtc.target);

        const usd1 = await oracle.toUSD(sdai.target, ethers.parseUnits("1000", 18));
        const usd2 = await oracle.toUSD(usdc.target, ethers.parseUnits("1000", 6));
        const usd3 = await oracle.toUSD(wbtc.target, ethers.parseUnits("1", 8));

        expect(usd1 + usd2 + usd3).to.equal(ethers.parseUnits("27020", 18));
      });

      it("returns 0 when amount = 0 in toUSD()", async () => {
        expect(await oracle.toUSD(usdc.target, 0)).to.equal(0n);
      });

      it("returns 0 when usdAmount = 0 in fromUSD()", async () => {
        expect(await oracle.fromUSD(usdc.target, 0)).to.equal(0n);
      });

      describe("Normalization invariants", function () {

        it("round-trips 6-decimal USDC", async () => {
          const feedUSDC = await MockAggregator.deploy(1e8, 8);
          await oracle.setChainlinkFeed(usdc.target, feedUSDC.target);
          await oracle["fetchAndUpdatePrice(address)"](usdc.target);

          const amount = ethers.parseUnits("123.456789", 6);
          const usd = await oracle.toUSD(usdc.target, amount);
          const back = await oracle.fromUSD(usdc.target, usd);

          expect(back).to.be.closeTo(amount, 1n);
        });

        it("round-trips 8-decimal WBTC", async () => {
          const feedWBTC = await MockAggregator.deploy(25000e8, 8);
          await oracle.setChainlinkFeed(wbtc.target, feedWBTC.target);
          await oracle["fetchAndUpdatePrice(address)"](wbtc.target);

          const amount = ethers.parseUnits("0.5", 8);
          const usd = await oracle.toUSD(wbtc.target, amount);
          const back = await oracle.fromUSD(wbtc.target, usd);

          expect(back).to.be.closeTo(amount, 1n);
        });

        it("round-trips 18-decimal ERC4626 vault token (sDAI)", async () => {
          const feedDAI = await MockAggregator.deploy(ethers.parseUnits("1", 18), 18);

          await oracle.setChainlinkFeed(dai.target, feedDAI.target);
          await oracle.setERC4626Vault(sdai.target, dai.target);

          await oracle["fetchAndUpdatePrice(address)"](dai.target);
          await oracle["fetchAndUpdatePrice(address)"](sdai.target);

          const amount = ethers.parseUnits("321.123456789012345678", 18);
          const usd = await oracle.toUSD(sdai.target, amount);
          const back = await oracle.fromUSD(sdai.target, usd);

          expect(back).to.be.closeTo(amount, 1n);
        });

        it("uses underlying asset price for ERC4626 vaults", async () => {
          await oracle.setChainlinkFeed(dai.target, feedDAI.target); // set Chainlink feed for DAI
          await oracle.setERC4626Vault(sdai.target, dai.target); // set ERC4626 mapping feed for sDAI to DAI

          await oracle["fetchAndUpdatePrice(address)"](dai.target); // init price cache
          await oracle["fetchAndUpdatePrice(address)"](sdai.target); // init price cache

          const amount = ethers.parseUnits("1000", 18);
          const usd = await oracle.toUSD(sdai.target, amount); // call getPrice() under the hood to fetch cached value & convert.

          expect(usd).to.equal(ethers.parseUnits("1020", 18)); // 2% yield
        });
      });
    });

    describe("getPriceAge()", function () {
      beforeEach(async () => {
        await setup();
        await oracle.setChainlinkFeed(usdc.target, feedUSDC.target);
      });

      it("returns max uint when no price has ever been set", async () => {
        const age = await oracle.getPriceAge(usdc.target);
        expect(age).to.equal(ethers.MaxUint256);
      });

      it("returns 0 immediately after fetchAndUpdatePrice()", async () => {
        await oracle["fetchAndUpdatePrice(address)"](usdc.target);

        const age = await oracle.getPriceAge(usdc.target);
        expect(age).to.equal(0n);
      });

      it("returns correct age after time passes", async () => {
        await oracle["fetchAndUpdatePrice(address)"](usdc.target);

        // simulate 500 seconds passing
        await ethers.provider.send("evm_increaseTime", [500]);
        await ethers.provider.send("evm_mine");

        const age = await oracle.getPriceAge(usdc.target);
        expect(age).to.equal(500n);
      });
    });

    describe("isPriceFresh()", function () {
      beforeEach(async () => {
        await setup();
        await oracle.setChainlinkFeed(usdc.target, feedUSDC.target);

        // stalePeriod defaults to 1 day in your setup
        await oracle["fetchAndUpdatePrice(address)"](usdc.target);
      });

      it("returns true immediately after price update", async () => {
        const fresh = await oracle.isPriceFresh(usdc.target);
        expect(fresh).to.equal(true);
      });

      it("returns true when age < stalePeriod", async () => {
        await ethers.provider.send("evm_increaseTime", [3600]); // +1 hour
        await ethers.provider.send("evm_mine");

        const fresh = await oracle.isPriceFresh(usdc.target);
        expect(fresh).to.equal(true);
      });

      it("returns false when age exceeds stalePeriod", async () => {
        const stale = 3600; // 1h
        await oracle.setStalePeriod(usdc.target, stale);

        // exceed stalePeriod
        await ethers.provider.send("evm_increaseTime", [stale + 1]);
        await ethers.provider.send("evm_mine");

        const fresh = await oracle.isPriceFresh(usdc.target);
        expect(fresh).to.equal(false);
      });

      it("returns false when no price exists", async () => {
        // New token, no price history
        const token2 = dai.target;

        const fresh = await oracle.isPriceFresh(token2);
        expect(fresh).to.equal(false);
      });
    });

  });
})

