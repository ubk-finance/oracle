// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@chainlink/contracts/src/v0.8/interfaces/AutomationCompatibleInterface.sol";
import "../../interfaces/IUBKOracle.sol";

contract OracleKeeper is AutomationCompatibleInterface {
    IUBKOracle public immutable oracle;

    uint256 public lastRun;
    uint256 public interval; // configurable upkeep interval

    uint256 public constant MIN_INTERVAL = 15 minutes;
    uint256 public constant MAX_INTERVAL = 24 hours;

    constructor(address _oracle, uint256 _interval) {
        require(
            _interval >= MIN_INTERVAL && _interval <= MAX_INTERVAL,
            "Interval out of bounds"
        );

        oracle = IUBKOracle(_oracle);
        interval = _interval;
    }

    // Chainlink Automation
    function checkUpkeep(bytes calldata)
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory)
    {
        upkeepNeeded = block.timestamp >= lastRun + interval;
    }

    function performUpkeep(bytes calldata) external override {
        if (block.timestamp < lastRun + interval) return;

        lastRun = block.timestamp;
        oracle.fetchAndUpdatePrice(oracle.getSupportedTokens());
    }

    // Gelato
    function run() external {
        if (block.timestamp < lastRun + interval) return;

        lastRun = block.timestamp;
        oracle.fetchAndUpdatePrice(oracle.getSupportedTokens());
    }
}