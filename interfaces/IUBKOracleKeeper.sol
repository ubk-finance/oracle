interface IUBKOracleKeeper {
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
