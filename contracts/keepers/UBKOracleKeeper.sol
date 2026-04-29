// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@chainlink/contracts/src/v0.8/interfaces/AutomationCompatibleInterface.sol";
import "../../interfaces/IUBKOracle.sol";

contract OracleKeeper is AutomationCompatibleInterface {
    IUBKOracle public immutable oracle;
    uint256 public lastRun;

    constructor(address _oracle) {
        oracle = IUBKOracle(_oracle);
    }

    // Chainlink Automation
    function checkUpkeep(bytes calldata)
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory)
    {
        upkeepNeeded = block.timestamp >= lastRun + 12 hours;
    }

    function performUpkeep(bytes calldata) external override {
        if (block.timestamp < lastRun + 12 hours) return;

        lastRun = block.timestamp;
        oracle.fetchAndUpdatePrice(oracle.getSupportedTokens());
    }

    // Gelato
    function run() external {
        if (block.timestamp < lastRun + 12 hours) return;

        lastRun = block.timestamp;
        oracle.fetchAndUpdatePrice(oracle.getSupportedTokens());
    }
}