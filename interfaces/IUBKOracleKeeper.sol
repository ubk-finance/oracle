interface IUBKOracleKeeper {
    event KeeperIntervalUpdated(uint256 oldInterval, uint256 newInterval);
    event KeeperTaskCompleted(uint256 timestamp);
}
