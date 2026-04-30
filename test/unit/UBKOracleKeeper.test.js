const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { fixture } = require("../helpers/fixture");

let deployer, user, oracle, usdc, dai, sdai, feedUSDC, feedWBTC, feedDAI, wbtc, MockERC20, Mock4626, MockAggregator, DAY;


function bindCtx(ctx) {
    ({
        deployer, user, oracle, usdc, dai,
        sdai, feedUSDC, feedWBTC, feedDAI,
        wbtc, MockERC20, Mock4626, MockAggregator, DAY
    } = ctx);
}

describe("UBKOracleKeeper", function () {
    let keeper;

    beforeEach(async () => {
        // reuse full oracle + token setup
        const ctx = await fixture();
        bindCtx(ctx);

        const Keeper = await ethers.getContractFactory("UBKOracleKeeper");
        keeper = await Keeper.deploy(deployer.address, oracle.target);
    });

    describe("Constructor", function () {
        it("sets owner, oracle and initializes state correctly", async () => {
            expect(await keeper.owner()).to.equal(deployer.address);
            expect(await keeper.oracle()).to.equal(oracle.target);

            const [needed] = await keeper.checkUpkeep("0x"); // Must be true for a fresh keeper. 

            expect(await keeper.lastRun()).to.equal(0); // Init state.
            expect(await keeper.interval()).to.equal(DAY / 2); // Init state.
            expect(needed).to.equal(true); // Init state.
        });
    });

    describe("Admin", function () {
        describe("setInterval()", function () {
            it("should allow owner to set valid interval and emit event", async () => {
                const newInterval = DAY;

                await expect(keeper.setInterval(newInterval))
                    .to.emit(keeper, "KeeperIntervalUpdated");

                expect(await keeper.interval()).to.equal(newInterval);
            });

            it("should revert if non-owner tries to set interval", async () => {
                await expect(
                    keeper.connect(user).setInterval(DAY)
                ).to.be.revertedWithCustomError(keeper, "OwnableUnauthorizedAccount");
            });

            it("should revert if interval outside bounds", async () => {
                await expect(keeper.setInterval(1))
                    .to.be.revertedWithCustomError(keeper, "InvalidThreshold");

                await expect(keeper.setInterval(DAY + 1))
                    .to.be.revertedWithCustomError(keeper, "InvalidThreshold");
            });
        });

        describe("setRetryFactor()", function () {
            it("should allow owner to set valid retryFactor and emit event", async () => {
                const newRetryFactor = DAY / 4; // must be < interval (default = DAY/2)

                await expect(keeper.setRetryFactor(newRetryFactor))
                    .to.emit(keeper, "KeeperRetryFactorUpdated");

                expect(await keeper.retryFactor()).to.equal(newRetryFactor);
            });

            it("should allow owner to set retryFactor equal to interval", async () => {
                const interval = await keeper.interval();

                await keeper.setRetryFactor(interval);
                expect(await keeper.retryFactor()).to.equal(interval);
            });

            it("should revert if non-owner tries to set retryFactor", async () => {
                const newRetryFactor = DAY / 4;

                await expect(
                    keeper.connect(user).setRetryFactor(newRetryFactor)
                ).to.be.revertedWithCustomError(keeper, "OwnableUnauthorizedAccount");
            });

            it("should revert if if retryFactor outside bounds", async () => {
                // too small
                await expect(keeper.setRetryFactor(1))
                    .to.be.revertedWithCustomError(keeper, "InvalidThreshold");

                // too large (beyond max interval)
                await expect(keeper.setRetryFactor(DAY + 1))
                    .to.be.revertedWithCustomError(keeper, "InvalidThreshold");
            });

            it("should revert if if retryFactor > interval", async () => {
                const interval = await keeper.interval(); // default = DAY / 2

                await expect(keeper.setRetryFactor(interval + 1n))
                    .to.be.revertedWithCustomError(keeper, "InvalidThreshold");
            });
        });
    });

    describe("External API", function () {
        describe("timeToUpkeep()", function () {
            it("returns lastRun + interval when last execution succeeded", async () => {
                const interval = await keeper.interval();
        
                // trigger a successful upkeep
                await keeper.performUpkeep("0x");
                const lastRun = await keeper.lastRun();
        
                const next = await keeper.timeToUpkeep();
        
                expect(next).to.equal(lastRun + interval);
            });
        
            it("returns lastRun + retryFactor when last execution failed", async () => {
                // force oracle failure
                await oracle.setOracleMode(1); // PAUSED -> will revert
        
                await keeper.performUpkeep("0x");
        
                const lastRun = await keeper.lastRun();
                const retryFactor = await keeper.retryFactor();
        
                expect(await keeper.lastExecutionFailed()).to.equal(true);
        
                const next = await keeper.timeToUpkeep();
        
                expect(next).to.equal(lastRun + retryFactor);
            });
        
            it("updates correctly after failure then success", async () => {
                // Step 1: cause failure
                await oracle.setOracleMode(1);
                await keeper.performUpkeep("0x");
        
                let lastRun = await keeper.lastRun();
                let retryFactor = await keeper.retryFactor();
        
                let next = await keeper.timeToUpkeep();
                expect(next).to.equal(lastRun + retryFactor);
        
                // Step 2: recover oracle and succeed
                await time.increase(retryFactor + 1n);
                await oracle.setOracleMode(0);
        
                await keeper.performUpkeep("0x");
        
                lastRun = await keeper.lastRun();
                const interval = await keeper.interval();
        
                next = await keeper.timeToUpkeep();
                expect(next).to.equal(lastRun + interval);
            });
        
            it("returns interval-based timestamp for fresh state (no runs yet)", async () => {
                const interval = await keeper.interval();
                const lastRun = await keeper.lastRun(); // should be 0
        
                const next = await keeper.timeToUpkeep();
        
                expect(lastRun).to.equal(0);
                expect(next).to.equal(interval);
            });
        });

        describe("checkUpkeep()", function () {
            it("returns true if no previous update", async () => {
                const [needed] = await keeper.checkUpkeep("0x");
                const lastRun = await keeper.lastRun();

                expect(lastRun).to.equal(0); // Default state. No successful runs before.
                expect(needed).to.equal(true); // Must run as (0 + 12 hrs(default interval)) < block.timestamp
            });

            it("returns false immediately after update", async () => {
                const lastRunBefore = await keeper.lastRun(); // Must be 0
                await keeper.performUpkeep("0x"); // Run the upkeep function.
                const lastRunAfter = await keeper.lastRun(); // Must be > 0

                expect(lastRunAfter - lastRunBefore).to.be.gt(0); // Verify diff > 0.

                const [needed] = await keeper.checkUpkeep("0x");
                expect(needed).to.equal(false); // Default interval is 12 hours. Upkeep is not needed.
            });

            it("returns true after interval passes", async () => {
                const interval = await keeper.interval();
                expect(interval).to.equal(DAY / 2); // Must be 12 hours for default setting.

                await time.increase(DAY / 2 + 1); // Increase time to beyond 12 hours.

                const [needed] = await keeper.checkUpkeep("0x");
                expect(needed).to.equal(true);
            });
        });

        describe("performUpkeep()", function () {
            it("performs upkeep and emits events when checkUpkeep() returns true", async () => {
                const [needed] = await keeper.checkUpkeep("0x"); // Will be true for fresh keeper.
                expect(needed).to.equal(true); // Sanity check
                await expect(keeper.performUpkeep("0x"))
                    .to.emit(keeper, "KeeperTaskCompleted"); // Should emit event after performing upkeep duties.
            });

            it("updates oracle prices when interval passes", async () => {
                await time.increase(DAY); // Fast forward time > owner set interval.
                const [needed] = await keeper.checkUpkeep("0x"); // Must return true.
                expect(needed).to.equal(true); // Sanity check
                await expect(keeper.performUpkeep("0x")).to.emit(keeper, "KeeperTaskCompleted");
                expect(await keeper.lastRun()).to.be.gt(0);
            });

            it("updates lastRun even if oracle fails", async () => {
                await oracle.setOracleMode(1); // Set Oracle to PAUSED so that it reverts keeper.
                const [needed] = await keeper.checkUpkeep("0x"); // Must return true.
                const lastRunBefore = await keeper.lastRun(); // lastRun before running the failed call to run()
                expect(needed).to.equal(true); // Sanity check
                await expect(keeper.performUpkeep("0x"))
                    .to.emit(keeper, "KeeperTaskFailed"); // Confirm failure.
                expect(await keeper.lastExecutionFailed()).to.equal(true); // Failure case confirmation.
                const lastRunAfter = await keeper.lastRun(); // lastRun after the failed call to run()
                expect(lastRunAfter).to.be.gt(lastRunBefore); // Confirm that lastRun was still modified.
            });

            it("allows for successful retries post oracle recovery", async () => {
                // create a failure state for the oracle and keeper first.
                await oracle.setOracleMode(1);  // set to PAUSED. will revert requests to fetchAndUpdatePrice().
                const [needed] = await keeper.checkUpkeep("0x"); // Must return true.
                expect(needed).to.equal(true); // Sanity check
                await expect(keeper.performUpkeep("0x"))
                    .to.emit(keeper, "KeeperTaskFailed"); // Failure case.
                expect(await keeper.lastExecutionFailed()).to.equal(true); // Failure case confirmation.

                // recover oracle
                await time.increase(await keeper.retryFactor() + 1n);
                await oracle.setOracleMode(0); // Move oracle back to NORMAL mode

                await expect(keeper.performUpkeep("0x"))
                    .to.emit(keeper, "KeeperTaskCompleted"); // Success case.
                expect(await keeper.lastRun()).to.be.gt(0); // Success case confirmation.
            });

            it("performs a graceful no-op when checkUpkeep() returns false", async () => {
                const [needed] = await keeper.checkUpkeep("0x"); // Will be true for fresh keeper.
                expect(needed).to.equal(true); // Sanity check
                await expect(keeper.performUpkeep("0x"))
                    .to.emit(keeper, "KeeperTaskCompleted"); // Should emit event after performing upkeep duties.
                const lastRunBefore = await keeper.lastRun(); // lastRun post successful execution of run().

                const [neededAfter] = await keeper.checkUpkeep("0x"); // Will be false for fresh keeper.
                expect (neededAfter).to.equal(false); // neededAfter must return false, since interval has not passed.
                await expect(keeper.performUpkeep("0x"))
                .to.not.emit(keeper, "KeeperTaskCompleted"); // Should NOT emit event after performing upkeep duties.
                const lastRunAfter = await keeper.lastRun(); // lastRun post no-op execution of run().

                expect(lastRunAfter).to.equal(lastRunBefore); // lastRunBefore MUST equal lastRunAfter in case of no-op.
            });

        });

        describe("run()", function () {
            it("performs upkeep and emits events when checkUpkeep() returns true", async () => {
                const [needed] = await keeper.checkUpkeep("0x"); // Will be true for fresh keeper.
                expect(needed).to.equal(true); // Sanity check
                await expect(keeper.run())
                    .to.emit(keeper, "KeeperTaskCompleted"); // Should emit event after performing upkeep duties.
            });

            it("updates oracle prices when interval passes", async () => {
                await time.increase(DAY); // Fast forward time > owner set interval.
                const [needed] = await keeper.checkUpkeep("0x"); // Must return true.
                expect(needed).to.equal(true); // Sanity check
                await expect(keeper.run()).to.emit(keeper, "KeeperTaskCompleted");
                expect(await keeper.lastRun()).to.be.gt(0);
            });

            it("updates lastRun even if oracle fails", async () => {
                await oracle.setOracleMode(1); // Set Oracle to PAUSED so that it reverts keeper.
                const [needed] = await keeper.checkUpkeep("0x"); // Must return true.
                const lastRunBefore = await keeper.lastRun(); // lastRun before running the failed call to run()
                expect(needed).to.equal(true); // Sanity check
                await expect(keeper.run())
                    .to.emit(keeper, "KeeperTaskFailed"); // Confirm failure.
                expect(await keeper.lastExecutionFailed()).to.equal(true); // Failure case confirmation.
                const lastRunAfter = await keeper.lastRun(); // lastRun after the failed call to run()
                expect(lastRunAfter).to.be.gt(lastRunBefore); // Confirm that lastRun was still modified.
            });

            it("allows for successful retries post oracle recovery", async () => {
                // create a failure state for the oracle and keeper first.
                await oracle.setOracleMode(1);  // set to PAUSED. will revert requests to fetchAndUpdatePrice().
                const [needed] = await keeper.checkUpkeep("0x"); // Must return true.
                expect(needed).to.equal(true); // Sanity check
                await expect(keeper.run())
                    .to.emit(keeper, "KeeperTaskFailed"); // Failure case.
                expect(await keeper.lastExecutionFailed()).to.equal(true); // Failure case confirmation.

                // recover oracle
                await time.increase(await keeper.retryFactor()); // 3 hours. Default backoff.
                await oracle.setOracleMode(0); // Move oracle back to NORMAL mode

                await expect(keeper.run())
                    .to.emit(keeper, "KeeperTaskCompleted"); // Success case.
                expect(await keeper.lastRun()).to.be.gt(0); // Success case confirmation.
            });

            it("performs a graceful no-op when checkUpkeep() returns false", async () => {
                const [needed] = await keeper.checkUpkeep("0x"); // Will be true for fresh keeper.
                expect(needed).to.equal(true); // Sanity check
                await expect(keeper.run())
                    .to.emit(keeper, "KeeperTaskCompleted"); // Should emit event after performing upkeep duties.
                const lastRunBefore = await keeper.lastRun(); // lastRun post successful execution of run().

                const [neededAfter] = await keeper.checkUpkeep("0x"); // Will be false for fresh keeper.
                expect (neededAfter).to.equal(false); // neededAfter must return false, since interval has not passed.
                await expect(keeper.run())
                .to.not.emit(keeper, "KeeperTaskCompleted"); // Should NOT emit event after performing upkeep duties.
                const lastRunAfter = await keeper.lastRun(); // lastRun post no-op execution of run().

                expect(lastRunAfter).to.equal(lastRunBefore); // lastRunBefore MUST equal lastRunAfter in case of no-op.
            });
        });
    });
});
