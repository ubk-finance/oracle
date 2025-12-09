// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@ubk-labs/ubk-commons/contracts/constants/UBKConstants.sol";

library UBKOracleConstants {
    // -----------------------------------------------------------------------
    // UBK System Constants
    // -----------------------------------------------------------------------

    uint256 public constant WAD = UBKConstants.WAD;

    // -----------------------------------------------------------------------
    // Oracle Price Bounds
    // -----------------------------------------------------------------------
    uint256 public constant ORACLE_MANUAL_PRICE_MAX_DELTA_WAD = 0.1e18; // 10%
    uint256 public constant ORACLE_MIN_ABSOLUTE_PRICE_WAD = 1e10; // 0.00000001
    uint256 public constant ORACLE_MAX_ABSOLUTE_PRICE_WAD = 1e24; // 1,000,000

    // -----------------------------------------------------------------------
    // Oracle Vault Rate Bounds
    // -----------------------------------------------------------------------
    uint256 public constant ORACLE_MIN_VAULT_RATE_WAD = 0.2e18; // 0.2x (20%)
    uint256 public constant ORACLE_MAX_VAULT_RATE_WAD = 3e18; // 3x (300%)

    // -----------------------------------------------------------------------
    // Oracle Staleness Periods
    // -----------------------------------------------------------------------
    uint256 public constant ORACLE_DEFAULT_STALE_PERIOD = 1 hours;
    uint256 public constant ORACLE_MIN_STALE_PERIOD = 1 hours;
    uint256 public constant ORACLE_MAX_STALE_PERIOD = 48 hours;

    // -----------------------------------------------------------------------
    // Oracle Recursion
    // -----------------------------------------------------------------------
    uint256 public constant MAX_RECURSION_DEPTH = 5;
}
