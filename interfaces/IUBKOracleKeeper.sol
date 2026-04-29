// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IUBKOracleKeeper {
    /// @notice Operational state of the oracle.
    enum KeeperMode {
        NORMAL,
        PAUSED
    }

    event KeeperIntervalUpdated(uint256 oldInterval, uint256 newInterval);
    event KeeperTaskCompleted(
        address indexed caller,
        uint256 timestamp,
        uint256 interval
    );
    event KeeperTaskFailed(
        address indexed caller,
        uint256 timestamp,
        uint256 interval
    );
}
