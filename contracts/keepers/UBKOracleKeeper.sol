// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@chainlink/contracts/src/v0.8/interfaces/AutomationCompatibleInterface.sol";

import "../../interfaces/IUBKOracle.sol";
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
contract UBKOracleKeeper is AutomationCompatibleInterface, Ownable {
    IUBKOracle public immutable oracle; // Oracle is immutable post construction.

    uint256 public lastRun; // Defaults to 0.
    uint256 public interval =
        UBKOracleConstants.ORACLE_DEFAULT_CHAINLINK_KEEPER_INTERVAL; // Defaults to 12 hours.

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
        upkeepNeeded = block.timestamp >= lastRun + interval;
    }

    /**
     * @notice Performs a Chainlink Automation-triggered oracle price update.
     *
     * @dev This function is permissionless and intended to be called by Chainlink
     *      Automation, though any address may call it. If the configured interval
     *      has not elapsed, the function exits without reverting.
     *
     * Updates `lastRun` before calling the oracle, then fetches the currently
     * supported tokens from the oracle and triggers a price update for them.
     *
     */
    function performUpkeep(bytes calldata) external override {
        if (block.timestamp < lastRun + interval) return;

        lastRun = block.timestamp;
        oracle.fetchAndUpdatePrice(oracle.getSupportedTokens());
    }

    /**
     * @notice Updates the keeper execution interval.
     *
     * @dev Restricted to the contract owner. Reverts if `_interval` is outside the
     *      protocol-defined minimum and maximum bounds.
     *
     * @param _interval New keeper execution interval, in seconds.
     */
    function setInterval(uint256 _interval) external onlyOwner {
        if (
            _interval >
            UBKOracleConstants.ORACLE_MAX_CHAINLINK_KEEPER_INTERVAL ||
            _interval < UBKOracleConstants.ORACLE_MIN_CHAINLINK_KEEPER_INTERVAL
        ) {
            revert InvalidThreshold(
                "UBKOracleKeeper::setInterval",
                msg.sender,
                _interval
            );
        }
        interval = _interval;
    }

    /**
     * @notice Performs a Gelato-triggered oracle price update.
     *
     * @dev This function is permissionless and intended to be called by Gelato,
     *      though any address may call it. If the configured interval has not
     *      elapsed, the function exits without reverting.
     *
     * Updates `lastRun` before calling the oracle, then fetches the currently
     * supported tokens from the oracle and triggers a price update for them.
     */
    function run() external {
        if (block.timestamp < lastRun + interval) return;

        lastRun = block.timestamp;
        oracle.fetchAndUpdatePrice(oracle.getSupportedTokens());
    }
}
