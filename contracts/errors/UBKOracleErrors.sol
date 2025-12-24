// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@ubk-labs/ubk-commons/contracts/errors/UBKErrors.sol";

// ───────────── Errors ─────────────
error ERC4626DecimalsMismatch(
    string functionName,
    address vault,
    address underlying
);
error InvalidERC4626Vault(address vault);
error InvalidFeedContract(address feed);
error InvalidFeedDecimals(address feed, uint8 decimals);
error InvalidManualPrice(address token, uint256 price);
error InvalidOraclePrice(address token, uint256 price);
error InvalidStalePeriod(uint256 period);
error InvalidVaultBounds(address vault, uint256 minRate, uint256 maxRate);
error InvalidVaultExchangeRate(address vault, uint256 rate);
error NoFallbackPrice(address token);
error NoPriceFeed(address token);
error OraclePaused(address oracle, uint256 timestamp);
error RecursiveResolution(address token);
error StaleFallback(address token);
error StalePrice(address token, uint256 updatedAt, uint256 currentTime);
error SuspiciousVaultRate(address vault, uint256 rate);
error TokenNotSupported(address token);
