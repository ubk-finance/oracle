// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@chainlink/contracts/src/v0.8/interfaces/AutomationCompatibleInterface.sol";

import "../../interfaces/IUBKOracle.sol";
import "../../interfaces/IUBKOracleKeeper.sol";
import "../constants/UBKOracleConstants.sol";
import "../errors/UBKOracleErrors.sol";

/**
 * @title UBKOracleKeeper
 * @author UBK Labs
 * @notice Automation-compatible keeper contract responsible for periodically triggering
 *         oracle price updates via Chainlink Automation or Gelato.
 *
 * @dev
 * - Supports both Chainlink Automation (`checkUpkeep` / `performUpkeep`)
 *   and Gelato (`run`) execution paths.
 * - Enforces a configurable execution interval bounded by protocol-defined limits.
 * - The oracle address is immutable and trusted at deployment.
 *
 * Security considerations:
 * - `performUpkeep` and `run` are permissionless but gated by time checks.
 * - `setInterval` is restricted to the contract owner.
 */
contract UBKOracleKeeper is
    AutomationCompatibleInterface,
    IUBKOracleKeeper,
    Ownable
{
    // KEEPER DATA PLANE
    IUBKOracle public immutable oracle; // Oracle is immutable post construction.

    // KEEPER CONTROL PLANE - EXECUTIONS

    /// @notice Flag tracking Keeper operational status. Initializes to NORMAL.
    KeeperMode public mode = KeeperMode.NORMAL;

    /// @notice Timestamp of last attempted execution of upkeep logic. Initalizes to 0.
    uint256 public lastExecutionAttempt;

    /// @notice Current keeper execution interval when last execution attempt did not fail. Initializes to 12 hours.
    uint256 public interval = UBKOracleConstants.ORACLE_DEFAULT_KEEPER_INTERVAL;

    /// @notice Flag tracking failure status of last upkeep attempt. Initializes to false
    bool public lastExecutionFailed;

    // KEEPER CONTROL PLANE - RETRIES
    uint256 public retryFactor = UBKOracleConstants.ORACLE_MIN_KEEPER_INTERVAL; // Initializes retry factor to lower bound of keeper interval.

    /**
     * @notice Initializes the keeper with an owner and oracle contract.
     * @param _owner Address that will be granted ownership of the contract.
     * @param _oracle Address of the oracle contract to be triggered by the keeper.
     *
     * @dev
     * - `_oracle` is assumed to be a valid IUBKOracle implementation.
     * - Ownership is set via OpenZeppelin Ownable.
     */
    constructor(address _owner, address _oracle) Ownable(_owner) {
        oracle = IUBKOracle(_oracle);
    }

    /// @notice Used to control _executeUpkeep() execution by owner. Reverts the decorated function when keeper is paused.
    modifier whenNotPaused() {
        if (mode == KeeperMode.PAUSED) revert KeeperPaused(block.timestamp);
        _;
    }

    // -----------------------------------------------------------------------
    // Admin / Configuration
    // -----------------------------------------------------------------------

    /**
     * @notice Updates the keeper execution interval.
     *
     * @dev Restricted to the contract owner. Reverts if `_interval` is outside the
     *      protocol-defined minimum and maximum bounds.
     *
     * @param _interval New keeper execution interval, in seconds.
     */
    function setInterval(uint256 _interval) external onlyOwner {
        // Validate _interval first.
        if (
            _interval > UBKOracleConstants.ORACLE_MAX_KEEPER_INTERVAL ||
            _interval < UBKOracleConstants.ORACLE_MIN_KEEPER_INTERVAL
        ) {
            revert InvalidThreshold(
                "UBKOracleKeeper::setInterval",
                msg.sender,
                _interval
            );
        }

        // Update state.
        uint256 oldInterval = interval;
        interval = _interval;

        // Emit event for observability.
        emit KeeperIntervalUpdated(oldInterval, interval);
    }

    /**
     * @notice Updates the keeper retry interval when run() or performUpkeep() fail, and the lastExecutionFailed flag is set to true.
     *
     * @dev Restricted to the contract owner. Reverts if `_retryFactor` is outside the
     *      protocol-defined minimum and maximum bounds for keeper intervals, as well as if the retryFactor is larger than the regular interval.
     *
     * @param _retryFactor New keeper retry factor, in seconds.
     */
    function setRetryFactor(uint256 _retryFactor) external onlyOwner {
        // Validate _interval first.
        if (
            _retryFactor > UBKOracleConstants.ORACLE_MAX_KEEPER_INTERVAL ||
            _retryFactor < UBKOracleConstants.ORACLE_MIN_KEEPER_INTERVAL ||
            _retryFactor > interval // Retry factor MUST be lesser than interval.
        ) {
            revert InvalidThreshold(
                "UBKOracleKeeper::setRetryFactor",
                msg.sender,
                _retryFactor
            );
        }

        // Update state.
        uint256 oldRetryFactor = retryFactor;
        retryFactor = _retryFactor;

        // Emit event for observability.
        emit KeeperRetryFactorUpdated(oldRetryFactor, retryFactor);
    }

    /**
     * @notice Updates the keeper operating mode.
     *
     * @dev Restricted to the contract owner.
     *      The keeper mode acts as a circuit breaker for oracle update execution:
     *      - In NORMAL mode, keeper executions proceed as usual.
     *      - In PAUSED mode, executions are blocked via `whenNotPaused`, preventing
     *        further oracle update attempts.
     *
     *      This mechanism is intended to mitigate unnecessary fund expenditure in
     *      scenarios where downstream oracle updates repeatedly fail beyond an
     *      acceptable threshold.
     *
     * @param _mode New keeper mode.
     */
    function setMode(KeeperMode _mode) external onlyOwner {
        // Update state.
        mode = _mode;

        // Emit event for observability.
        emit KeeperModeUpdated(uint40(mode), block.timestamp);
    }

    // -----------------------------------------------------------------------
    // Public API - Views
    // -----------------------------------------------------------------------

    /**
     * @notice Checks whether upkeep should be performed.
     * @return upkeepNeeded True if the configured interval has elapsed since the last run.
     *
     * @dev
     * - Called off-chain by Chainlink Automation nodes.
     * - Uses `block.timestamp` to determine eligibility.
     * - Does not perform any state changes.
     */
    function checkUpkeep(
        bytes calldata
    ) external view override returns (bool upkeepNeeded, bytes memory) {
        upkeepNeeded = _checkUpkeep();
    }

    /**
     * @notice Computes and returns the timestamp after which the next upkeep is to be attempted.
     * @return timestamp
     *
     */
    function timeToUpkeep() external view returns (uint256 timestamp) {
        return _timeToUpkeep();
    }

    // -----------------------------------------------------------------------
    // Public API - Mutators
    // -----------------------------------------------------------------------

    /**
     * @notice Performs a Chainlink Automation-triggered oracle price update.
     *
     * @dev This function is permissionless and intended to be called by Chainlink
     *      Automation, though any address may call it. If the configured interval
     *      has not elapsed, the function exits without reverting.
     *
     * Updates `lastExecutionAttempt` before calling the oracle, then fetches the currently
     * supported tokens from the oracle and triggers a price update for them.
     *
     */
    function performUpkeep(bytes calldata) external override {
        _executeUpkeep();
    }

    /**
     * @notice Performs a Gelato-triggered oracle price update.
     *
     * @dev This function is permissionless and intended to be called by Gelato,
     *      though any address may call it. If the configured interval has not
     *      elapsed, the function exits without reverting.
     *
     * Updates `lastExecutionAttempt` before calling the oracle, then fetches the currently
     * supported tokens from the oracle and triggers a price update for them.
     */
    function run() external {
        _executeUpkeep();
    }

    // -----------------------------------------------------------------------
    // Internal helpers - Views
    // -----------------------------------------------------------------------

    /**
     * @notice Executes the shared interval dependent upkeep logic.
     * @return upkeepNeeded True if the configured interval has elapsed since the last run.
     *
     * @dev
     * - Called by _executeUpkeep(), which in turn is called by both run() and performUpkeep().
     * - Uses `block.timestamp` to determine eligibility.
     * - Does not perform any state changes.
     */
    function _checkUpkeep() internal view returns (bool upkeepNeeded) {
        upkeepNeeded = block.timestamp >= _timeToUpkeep();
    }

    /**
     * @notice Computes and returns the timestamp after which the next upkeep attempt is to be attempted.
     * @return timestamp
     *
     * @dev
     * - Called by _checkUpkeep(), which in turn is called by both run() and performUpkeep().
     * - Does not perform any state changes.
     */
    function _timeToUpkeep() internal view returns (uint256 timestamp) {
        timestamp = lastExecutionAttempt + interval; // Default case. Last execution succeeded.
        if (lastExecutionFailed) {
            timestamp = lastExecutionAttempt + retryFactor; // Failure case. Last execution failed. Try again while avoiding retry storms.
        }
    }

    // -----------------------------------------------------------------------
    // Internal helpers - Mutators
    // -----------------------------------------------------------------------

    /**
     * @notice Executes the shared oracle keeper logic.
     *
     * @dev Called by both `performUpkeep` and `run`.
     *      If the configured interval has not elapsed, this function exits early
     *      without reverting.
     *
     * Attempts to fetch and update prices for all supported tokens via the oracle:
     * - On success: updates `lastExecutionAttempt` and emits `KeeperTaskCompleted`.
     * - On failure: does not update `lastExecutionAttempt` and emits `KeeperTaskFailed`.
     *
     * This design allows the keeper to retry execution on subsequent calls if the
     * oracle update fails, improving resilience to transient errors.
     */
    function _executeUpkeep() internal whenNotPaused {
        if (!_checkUpkeep()) return;

        lastExecutionAttempt = block.timestamp; // Update the lastExecutionAttempt timestamp regardless of execution success or failure.

        try oracle.fetchAndUpdatePrice(oracle.getSupportedTokens()) {
            lastExecutionFailed = false; // Mark success
            emit KeeperTaskCompleted(
                msg.sender,
                lastExecutionAttempt,
                interval
            );
        } catch {
            lastExecutionFailed = true; // Mark failure. Allow for retryFactor buffering.
            emit KeeperTaskFailed(msg.sender, block.timestamp, interval);
        }
    }
}
