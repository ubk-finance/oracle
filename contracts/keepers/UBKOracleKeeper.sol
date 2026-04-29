// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@chainlink/contracts/src/v0.8/interfaces/AutomationCompatibleInterface.sol";

import "../../interfaces/IUBKOracle.sol";
import "../constants/UBKOracleConstants.sol";

contract UBKOracleKeeper is AutomationCompatibleInterface, Ownable {
    IUBKOracle public immutable oracle; // Oracle is immutable post construction.

    uint256 public lastRun; // Defaults to 0.
    uint256 public interval =
        UBKOracleConstants.ORACLE_DEFAULT_CHAINLINK_KEEPER_INTERVAL; // Defaults to 12 hours.

    constructor(address _owner, address _oracle) Ownable(_owner) {
        oracle = IUBKOracle(_oracle);
    }

    // Chainlink Automation
    function checkUpkeep(
        bytes calldata
    ) external view override returns (bool upkeepNeeded, bytes memory) {
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
