// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IUBKOracleKeeper {
    // Admin/Config events
    event KeeperIntervalUpdated(uint256 oldInterval, uint256 newInterval);
    event KeeperRetryFactorUpdated(uint256 oldRetryFactor, uint256 newRetryFactor);

    // Task execution events
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
