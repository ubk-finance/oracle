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

            expect(await keeper.lastExecutionAttempt()).to.equal(0); // Init state.
            expect(await keeper.regularInterval()).to.equal(DAY / 2); // Init state.
            expect(needed).to.equal(true); // Init state.
        });
    });

    describe("Admin", function () {
        describe("setRegularInterval()", function () {
            it("should allow owner to set valid interval and emit event", async () => {
                const newInterval = DAY;

                await expect(keeper.setRegularInterval(newInterval))
                    .to.emit(keeper, "KeeperRegularIntervalUpdated");

                expect(await keeper.regularInterval()).to.equal(newInterval);
            });

            it("should revert if non-owner tries to set interval", async () => {
                await expect(
                    keeper.connect(user).setRegularInterval(DAY)
                ).to.be.revertedWithCustomError(keeper, "OwnableUnauthorizedAccount");
            });

            it("should revert if interval outside bounds", async () => {
                await expect(keeper.setRegularInterval(1))
                    .to.be.revertedWithCustomError(keeper, "InvalidThreshold");

                await expect(keeper.setRegularInterval(DAY + 1))
                    .to.be.revertedWithCustomError(keeper, "InvalidThreshold");
            });
        });

        describe("setRetryInterval()", function () {
            it("should allow owner to set valid retryFactor and emit event", async () => {
                const newRetryInterval = DAY / 4; // must be < interval (default = DAY/2)

                await expect(keeper.setRetryInterval(newRetryInterval))
                    .to.emit(keeper, "KeeperRetryIntervalUpdated");

                expect(await keeper.retryInterval()).to.equal(newRetryInterval);
            });

            it("should allow owner to set retryFactor equal to interval", async () => {
                const interval = await keeper.regularInterval();

                await keeper.setRetryInterval(interval);
                expect(await keeper.retryInterval()).to.equal(interval);
            });

            it("should revert if non-owner tries to set retryFactor", async () => {
                const newRetryInterval = DAY / 4;

                await expect(
                    keeper.connect(user).setRetryInterval(newRetryInterval)
                ).to.be.revertedWithCustomError(keeper, "OwnableUnauthorizedAccount");
            });

            it("should revert if if retryFactor outside bounds", async () => {
                // too small
                await expect(keeper.setRetryInterval(1))
                    .to.be.revertedWithCustomError(keeper, "InvalidThreshold");

                // too large (beyond max interval)
                await expect(keeper.setRetryInterval(DAY + 1))
                    .to.be.revertedWithCustomError(keeper, "InvalidThreshold");
            });

            it("should revert if if retryFactor > interval", async () => {
                const interval = await keeper.regularInterval(); // default = DAY / 2

                await expect(keeper.setRetryInterval(interval + 1n))
                    .to.be.revertedWithCustomError(keeper, "InvalidThreshold");
            });
        });

        describe("setMode()", function () {
            it("should allow owner to update keeper mode and emit event", async () => {
                // Assuming enum: NORMAL = 0, PAUSED = 1
                const PAUSED = 1;

                await expect(keeper.setMode(PAUSED))
                    .to.emit(keeper, "KeeperModeUpdated")
                    .withArgs(PAUSED, anyValue);

                expect(await keeper.mode()).to.equal(PAUSED);
            });

            it("should revert if non-owner tries to set keeper mode", async () => {
                const PAUSED = 1;

                await expect(
                    keeper.connect(user).setMode(PAUSED)
                ).to.be.revertedWithCustomError(keeper, "OwnableUnauthorizedAccount");
            });

            it("should allow switching back to NORMAL mode", async () => {
                const NORMAL = 0;
                const PAUSED = 1;

                await keeper.setMode(PAUSED);
                expect(await keeper.mode()).to.equal(PAUSED);

                await keeper.setMode(NORMAL);
                expect(await keeper.mode()).to.equal(NORMAL);
            });
        });
    });

    describe("External API", function () {
        describe("timeToUpkeep()", function () {
            it("returns lastExecutionAttempt + interval when last execution succeeded", async () => {
                const interval = await keeper.regularInterval();

                // trigger a successful upkeep
                await keeper.performUpkeep("0x");
                const lastExecutionAttempt = await keeper.lastExecutionAttempt();

                const next = await keeper.timeToUpkeep();

                expect(next).to.equal(lastExecutionAttempt + interval);
            });

            it("returns lastExecutionAttempt + retryFactor when last execution failed", async () => {
                // force oracle failure
                await oracle.setOracleMode(1); // PAUSED -> will revert

                await keeper.performUpkeep("0x");

                const lastExecutionAttempt = await keeper.lastExecutionAttempt();
                const retryFactor = await keeper.retryInterval();

                expect(await keeper.lastExecutionFailed()).to.equal(true);

                const next = await keeper.timeToUpkeep();

                expect(next).to.equal(lastExecutionAttempt + retryFactor);
            });

            it("updates correctly after failure then success", async () => {
                // Step 1: cause failure
                await oracle.setOracleMode(1);
                await keeper.performUpkeep("0x");

                let lastExecutionAttempt = await keeper.lastExecutionAttempt();
                let retryFactor = await keeper.retryInterval();

                let next = await keeper.timeToUpkeep();
                expect(next).to.equal(lastExecutionAttempt + retryFactor);

                // Step 2: recover oracle and succeed
                await time.increase(retryFactor + 1n);
                await oracle.setOracleMode(0);

                await keeper.performUpkeep("0x");

                lastExecutionAttempt = await keeper.lastExecutionAttempt();
                const interval = await keeper.regularInterval();

                next = await keeper.timeToUpkeep();
                expect(next).to.equal(lastExecutionAttempt + interval);
            });

            it("returns interval-based timestamp for fresh state (no runs yet)", async () => {
                const interval = await keeper.regularInterval();
                const lastExecutionAttempt = await keeper.lastExecutionAttempt(); // should be 0

                const next = await keeper.timeToUpkeep();

                expect(lastExecutionAttempt).to.equal(0);
                expect(next).to.equal(interval);
            });
        });

        describe("checkUpkeep()", function () {
            it("returns true if no previous update", async () => {
                const [needed] = await keeper.checkUpkeep("0x");
                const lastExecutionAttempt = await keeper.lastExecutionAttempt();

                expect(lastExecutionAttempt).to.equal(0); // Default state. No successful runs before.
                expect(needed).to.equal(true); // Must run as (0 + 12 hrs(default interval)) < block.timestamp
            });

            it("returns false immediately after update", async () => {
                const lastExecutionAttemptBefore = await keeper.lastExecutionAttempt(); // Must be 0
                await keeper.performUpkeep("0x"); // Run the upkeep function.
                const lastExecutionAttemptAfter = await keeper.lastExecutionAttempt(); // Must be > 0

                expect(lastExecutionAttemptAfter - lastExecutionAttemptBefore).to.be.gt(0); // Verify diff > 0.

                const [needed] = await keeper.checkUpkeep("0x");
                expect(needed).to.equal(false); // Default interval is 12 hours. Upkeep is not needed.
            });

            it("returns true after interval passes", async () => {
                const interval = await keeper.regularInterval();
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
                expect(await keeper.lastExecutionAttempt()).to.be.gt(0);
            });

            it("updates lastExecutionAttempt even if oracle fails", async () => {
                await oracle.setOracleMode(1); // Set Oracle to PAUSED so that it reverts keeper.
                const [needed] = await keeper.checkUpkeep("0x"); // Must return true.
                const lastExecutionAttemptBefore = await keeper.lastExecutionAttempt(); // lastExecutionAttempt before running the failed call to run()
                expect(needed).to.equal(true); // Sanity check
                await expect(keeper.performUpkeep("0x"))
                    .to.emit(keeper, "KeeperTaskFailed"); // Confirm failure.
                expect(await keeper.lastExecutionFailed()).to.equal(true); // Failure case confirmation.
                const lastExecutionAttemptAfter = await keeper.lastExecutionAttempt(); // lastExecutionAttempt after the failed call to run()
                expect(lastExecutionAttemptAfter).to.be.gt(lastExecutionAttemptBefore); // Confirm that lastExecutionAttempt was still modified.
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
                await time.increase(await keeper.retryInterval() + 1n);
                await oracle.setOracleMode(0); // Move oracle back to NORMAL mode

                await expect(keeper.performUpkeep("0x"))
                    .to.emit(keeper, "KeeperTaskCompleted"); // Success case.
                expect(await keeper.lastExecutionAttempt()).to.be.gt(0); // Success case confirmation.
            });

            it("performs a graceful no-op when checkUpkeep() returns false", async () => {
                const [needed] = await keeper.checkUpkeep("0x"); // Will be true for fresh keeper.
                expect(needed).to.equal(true); // Sanity check
                await expect(keeper.performUpkeep("0x"))
                    .to.emit(keeper, "KeeperTaskCompleted"); // Should emit event after performing upkeep duties.
                const lastExecutionAttemptBefore = await keeper.lastExecutionAttempt(); // lastExecutionAttempt post successful execution of run().

                const [neededAfter] = await keeper.checkUpkeep("0x"); // Will be false for fresh keeper.
                expect(neededAfter).to.equal(false); // neededAfter must return false, since interval has not passed.
                await expect(keeper.performUpkeep("0x"))
                    .to.not.emit(keeper, "KeeperTaskCompleted"); // Should NOT emit event after performing upkeep duties.
                const lastExecutionAttemptAfter = await keeper.lastExecutionAttempt(); // lastExecutionAttempt post no-op execution of run().

                expect(lastExecutionAttemptAfter).to.equal(lastExecutionAttemptBefore); // lastExecutionAttemptBefore MUST equal lastExecutionAttemptAfter in case of no-op.
            });

            it("reverts when keeper mode is PAUSED", async () => {
                const [needed] = await keeper.checkUpkeep("0x"); // Will be true for fresh keeper.
                expect(needed).to.equal(true); // Sanity check
                await keeper.setMode(1); // set keeper mode to PAUSED
                await expect(keeper.performUpkeep("0x"))
                    .to.be.revertedWithCustomError(keeper, "KeeperPaused");
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
                expect(await keeper.lastExecutionAttempt()).to.be.gt(0);
            });

            it("updates lastExecutionAttempt even if oracle fails", async () => {
                await oracle.setOracleMode(1); // Set Oracle to PAUSED so that it reverts keeper.
                const [needed] = await keeper.checkUpkeep("0x"); // Must return true.
                const lastExecutionAttemptBefore = await keeper.lastExecutionAttempt(); // lastExecutionAttempt before running the failed call to run()
                expect(needed).to.equal(true); // Sanity check
                await expect(keeper.run())
                    .to.emit(keeper, "KeeperTaskFailed"); // Confirm failure.
                expect(await keeper.lastExecutionFailed()).to.equal(true); // Failure case confirmation.
                const lastExecutionAttemptAfter = await keeper.lastExecutionAttempt(); // lastExecutionAttempt after the failed call to run()
                expect(lastExecutionAttemptAfter).to.be.gt(lastExecutionAttemptBefore); // Confirm that lastExecutionAttempt was still modified.
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
                await time.increase(await keeper.retryInterval()); // 3 hours. Default backoff.
                await oracle.setOracleMode(0); // Move oracle back to NORMAL mode

                await expect(keeper.run())
                    .to.emit(keeper, "KeeperTaskCompleted"); // Success case.
                expect(await keeper.lastExecutionAttempt()).to.be.gt(0); // Success case confirmation.
            });

            it("performs a graceful no-op when checkUpkeep() returns false", async () => {
                const [needed] = await keeper.checkUpkeep("0x"); // Will be true for fresh keeper.
                expect(needed).to.equal(true); // Sanity check
                await expect(keeper.run())
                    .to.emit(keeper, "KeeperTaskCompleted"); // Should emit event after performing upkeep duties.
                const lastExecutionAttemptBefore = await keeper.lastExecutionAttempt(); // lastExecutionAttempt post successful execution of run().

                const [neededAfter] = await keeper.checkUpkeep("0x"); // Will be false for fresh keeper.
                expect(neededAfter).to.equal(false); // neededAfter must return false, since interval has not passed.
                await expect(keeper.run())
                    .to.not.emit(keeper, "KeeperTaskCompleted"); // Should NOT emit event after performing upkeep duties.
                const lastExecutionAttemptAfter = await keeper.lastExecutionAttempt(); // lastExecutionAttempt post no-op execution of run().

                expect(lastExecutionAttemptAfter).to.equal(lastExecutionAttemptBefore); // lastExecutionAttemptBefore MUST equal lastExecutionAttemptAfter in case of no-op.
            });

            it("reverts when keeper mode is PAUSED", async () => {
                const [needed] = await keeper.checkUpkeep("0x"); // Will be true for fresh keeper.
                expect(needed).to.equal(true); // Sanity check
                await keeper.setMode(1); // set keeper mode to PAUSED
                await expect(keeper.run())
                    .to.be.revertedWithCustomError(keeper, "KeeperPaused");
            });

        });
    });
});
