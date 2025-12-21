// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import "@ubk-labs/ubk-commons/contracts/abstract/UBKDecimalsBounded.sol";

import "../../interfaces/IUBKOracle.sol";
import "../errors/UBKOracleErrors.sol";
import "../constants/UBKOracleConstants.sol";

/**
 * @title Oracle
 * @notice This contract is an implementation of the IUBKOracle interface.
 *
 * @dev
 *  The oracle computes normalized 1e18 prices for all supported assets,
 *  combining manual overrides, ERC4626 vault conversions, and Chainlink feeds.
 *
 *  === PRICE RESOLUTION ORDER ===
 *  1️. Manual override (±10% bound from last valid)
 *  2. ERC4626 vault-derived (convertToAssets * underlying price)
 *  3️. Chainlink feed (normalized to 1e18)
 *
 *  === SAFETY FEATURES ===
 *  - Recursion guard (nested ERC4626 depth ≤ 5)
 *  - Chainlink stale-period enforcement
 *  - Vault rate sanity bounds (min/max rate per vault)
 *  - Manual mode ±10% limit if last valid < stalePeriod
 *  - Circuit breaker (paused mode)
 *  - Fallback to last valid price (if feed fails but within fallback window)
 *
 *  === DESIGN PHILOSOPHY ===
 *  - `getPrice()` returns cached prices only (for gas efficiency).
 *  - `fetchAndUpdatePrice()` pulls fresh on-chain data (keeper or contract call).
 *  - UI / Subgraphs can use `isPriceFresh()` and `getPriceAge()` for safety checks.
 *
 */
contract UBKOracle is IUBKOracle, UBKDecimalsBounded, Ownable {
    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    /// @notice Chainlink feed address per token.
    mapping(address => address) public chainlinkFeeds;

    /// @notice ERC4626 vault underlying token mapping.
    mapping(address => address) public erc4626Underlying;

    /// @notice Manual price overrides (scaled to 1e18).
    mapping(address => uint256) public manualPrices;

    /// @notice Manual mode flags.
    mapping(address => bool) public isManual;

    /// @notice Cache for last valid price lookup.
    mapping(address => LastValidPrice) public lastValidPrice;

    /// @notice Mapping to track vault rate bounds.
    mapping(address => VaultRateBounds) public vaultRateBounds;

    /// @notice Maximum staleness period for Chainlink feeds (seconds).
    mapping(address => uint256) public stalePeriod;

    /// @notice Staleness tolerance for fallback prices (seconds).
    mapping(address => uint256) public fallbackStalePeriod;

    OracleMode public mode = OracleMode.NORMAL;

    /// @notice Recursion tracking for nested ERC4626 vaults.
    uint256 private _recursionDepth;

    /// @notice Array to track supported tokens.
    address[] public supportedTokens;

    /// @notice Mapping to track supported tokens.
    mapping(address => bool) public isSupported;

    // -----------------------------------------------------------------------
    // Constructor & Modifiers
    // -----------------------------------------------------------------------

    /**
     * @notice Deploys the Oracle contract.
     * @param _owner The address to assign as the owner (governance or deployer).
     */
    constructor(address _owner) Ownable(_owner) {}

    /// @notice Ensures oracle is not paused.
    modifier whenNotPaused() {
        if (mode == OracleMode.PAUSED)
            revert OraclePaused(address(this), block.timestamp);
        _;
    }

    /// @notice Prevents infinite recursion when resolving nested ERC4626 vaults.
    modifier checkRecursion() {
        if (_recursionDepth >= UBKOracleConstants.ORACLE_MAX_RECURSION_DEPTH)
            revert RecursiveResolution(address(0));
        _recursionDepth++;
        _;
        _recursionDepth--;
    }

    // -----------------------------------------------------------------------
    // Admin / Configuration
    // -----------------------------------------------------------------------

    /**
     * @notice Switches oracle operating mode (NORMAL ↔ PAUSED).
     * @dev Paused mode halts all fetchAndUpdatePrice() calls.
     */
    function setOracleMode(OracleMode newMode) external onlyOwner {
        OracleMode oldMode = mode;
        mode = newMode;
        emit OracleModeChanged(oldMode, newMode);
    }

    /**
     * @notice Sets the maximum time (in seconds) a Chainlink feed value is valid.
     * @param period The new fallback staleness threshold. Must be 1.5x of stalePeriod of the same token.
     * @dev Must lie within [UBKOracleConstants.ORACLE_MIN_STALE_PERIOD, UBKOracleConstants.ORACLE_MAX_STALE_PERIOD].
     */
    function setStalePeriod(address token, uint256 period) external onlyOwner {
        if (
            period < UBKOracleConstants.ORACLE_MIN_STALE_PERIOD ||
            period > UBKOracleConstants.ORACLE_MAX_STALE_PERIOD
        ) revert InvalidStalePeriod(period);
        stalePeriod[token] = period;
        fallbackStalePeriod[token] =
            UBKOracleConstants.ORACLE_DEFAULT_STALE_FALLBACK_MULTIPLIER *
            period; //Minimum fallback period should be 2x stalePeriod[token].
        emit StalePeriodUpdated(token, stalePeriod[token]);
        emit FallbackStalePeriodUpdated(token, fallbackStalePeriod[token]);
    }

    /**
     * @notice Sets the fallback staleness tolerance for lastValidPrice().
     * @param period Maximum allowed seconds for fallback validity.
     * @dev Must be ≥ stalePeriod to remain meaningful.
     */
    function setFallbackStalePeriod(
        address token,
        uint256 period
    ) external onlyOwner {
        uint256 stalePeriodToken = stalePeriod[token]; // Default stale period of token.
        uint256 maxFallbackPeriod = stalePeriodToken *
            UBKOracleConstants.ORACLE_MAX_STALE_FALLBACK_MULTIPLIER; // The absolute maximum fallback stale period allowed. (3x)
        if (period < stalePeriodToken || period > maxFallbackPeriod)
            revert InvalidStalePeriod(period);
        fallbackStalePeriod[token] = period;
        emit FallbackStalePeriodUpdated(token, period);
    }

    /**
     * @notice Configures acceptable min/max conversion rates for a specific ERC4626 vault.
     * @param vault ERC4626 vault token address.
     * @param minRate Minimum acceptable rate (e.g., 0.2e18 = 0.2x).
     * @param maxRate Maximum acceptable rate (e.g., 3e18 = 3x).
     * @dev Prevents mispriced vaults or flash-manipulated convertToAssets().
     */
    function setVaultRateBounds(
        address vault,
        uint256 minRate,
        uint256 maxRate
    ) external onlyOwner {
        if (vault == address(0))
            revert ZeroAddress("UBKOracle::setVaultRateBounds", "vault");
        if (minRate == 0 || maxRate <= minRate || maxRate > 100e18)
            revert InvalidVaultBounds(vault, minRate, maxRate);

        vaultRateBounds[vault] = VaultRateBounds(minRate, maxRate);
        emit VaultRateBoundsSet(vault, minRate, maxRate);
    }

    /**
     * @notice Manually sets a price for a token, bounded by ±10% of last valid.
     * @param token Token address.
     * @param price Manual price in 1e18 precision.
     * @dev Enforces bounds if a valid recent price (< stalePeriod) exists.
     *      Enables manual mode until disabled.
     */
    function setManualPrice(
        address token,
        uint256 price
    ) external onlyOwner whenNotPaused {
        if (token == address(0))
            revert ZeroAddress("UBKOracle::setManualPrice", "token");
        if (
            price < UBKOracleConstants.ORACLE_MIN_ABSOLUTE_PRICE_WAD ||
            price > UBKOracleConstants.ORACLE_MAX_ABSOLUTE_PRICE_WAD
        ) revert InvalidManualPrice(token, price);

        LastValidPrice memory lv = lastValidPrice[token];
        if (
            lv.price > 0 && block.timestamp - lv.timestamp <= stalePeriod[token]
        ) {
            uint256 lowerBound = (lv.price *
                (UBKOracleConstants.WAD -
                    UBKOracleConstants.ORACLE_MANUAL_PRICE_MAX_DELTA_WAD)) /
                UBKOracleConstants.WAD;
            uint256 upperBound = (lv.price *
                (UBKOracleConstants.WAD +
                    UBKOracleConstants.ORACLE_MANUAL_PRICE_MAX_DELTA_WAD)) /
                UBKOracleConstants.WAD;
            if (price < lowerBound || price > upperBound)
                revert InvalidManualPrice(token, price);
        }

        manualPrices[token] = price;
        isManual[token] = true;
        lastValidPrice[token] = LastValidPrice(price, block.timestamp);

        emit ManualPriceSet(token, price);
        emit ManualModeEnabled(token, true);
        emit LastValidPriceUpdated(token, price, block.timestamp);
    }

    /**
     * @notice Disables manual pricing for a token.
     * @param token The token address.
     */
    function disableManualPrice(address token) external onlyOwner {
        if (token == address(0))
            revert ZeroAddress("UBKOracle::disableManualPrice", "token");
        isManual[token] = false;
        emit ManualModeEnabled(token, false);
    }

    /**
     * @notice Registers a Chainlink feed and validates its response.
     * @param token Asset token address.
     * @param feed Chainlink AggregatorV3 feed address.
     * @dev Ensures decimals ≤ 18 and feed returns a nonzero updatedAt value.
     */
    function setChainlinkFeed(address token, address feed) external onlyOwner {
        _validateChainlinkFeed(token, feed);

        AggregatorV3Interface agg = AggregatorV3Interface(feed);
        uint8 decimals = agg.decimals();
        if (decimals > 18) revert InvalidFeedDecimals(feed, decimals);

        try agg.latestRoundData() returns (
            uint80,
            int256 answer,
            uint256,
            uint256 updatedAt,
            uint80
        ) {
            if (answer <= 0 || updatedAt == 0) revert InvalidFeedContract(feed);
        } catch {
            revert InvalidFeedContract(feed);
        }
        chainlinkFeeds[token] = feed;
        isManual[token] = false;
        _addSupportedToken(token);
        emit ChainlinkFeedSet(token, feed);
    }

    /**
     * @notice Registers an ERC4626 vault and its underlying asset.
     * @param vault ERC4626 vault token.
     * @param underlying Reference underlying asset used for pricing.
     * @dev Does not enforce .asset() == underlying for flexibility
     *      (e.g., sUSDe → USDC pegging for depeg protection).
     */
    function setERC4626Vault(
        address vault,
        address underlying
    ) external onlyOwner {
        _validateERC4626Vault(vault, underlying);
        erc4626Underlying[vault] = underlying;
        _addSupportedToken(vault);
        emit ERC4626Registered(vault, underlying);
    }

    // -----------------------------------------------------------------------
    // External / Public API
    // -----------------------------------------------------------------------

    /**
     *  Public wrapper for internal _getPrice() method.
     */
    function getPrice(address token) external view returns (uint256 price) {
        return _getPrice(token);
    }

    /**
     * @notice Fetches, resolves, and caches the latest token price.
     * @param token Asset token address.
     * @return price Fresh price in 1e18 precision.
     * @dev Pulls live data from Chainlink or ERC4626 vaults.
     *      Should be called by protocol keepers or critical functions.
     */
    function fetchAndUpdatePrice(
        address token
    ) external whenNotPaused returns (uint256) {
        if (token == address(0))
            revert ZeroAddress("UBKOracle::fetchAndUpdatePrice", "token");
        return _fetchAndUpdatePrice(token);
    }

    /**
     * @notice Batch price fetch & update for multiple tokens.
     * @param tokens Array of asset token addresses.
     * @return prices Array of fresh prices in 1e18 precision.
     *
     * @dev
     *  - Runs whenNotPaused modifier.
     *  - Reverts if any token is zero address.
     *  - Each iteration calls the same internal `_fetchAndUpdatePrice`.
     *  - Gas-efficient: msg.sender checked once, calldata parsed once.
     */
    function fetchAndUpdatePrice(
        address[] calldata tokens
    ) external whenNotPaused returns (uint256[] memory prices) {
        uint256 len = tokens.length;
        prices = new uint256[](len);

        for (uint256 i = 0; i < len; ++i) {
            address token = tokens[i];
            if (token == address(0)) {
                revert ZeroAddress(
                    "UBKOracle::fetchAndUpdatePriceBatch",
                    "token"
                );
            }

            prices[i] = _fetchAndUpdatePrice(token);
        }
    }

    /**
     * @notice Returns age of last cached price in seconds.
     * @param token Token address.
     * @return age Time since lastValidPrice update.
     */
    function getPriceAge(address token) external view returns (uint256 age) {
        LastValidPrice memory lv = lastValidPrice[token];
        if (lv.timestamp == 0) return type(uint256).max;
        return block.timestamp - lv.timestamp;
    }

    /** Public wrapper for _isPriceFresh
     * @notice Checks if cached price is within freshness threshold.
     * @return isFresh True if price updated ≤ stalePeriod ago.
     */
    function isPriceFresh(address token) external view returns (bool isFresh) {
        return _isPriceFresh(token);
    }

    /**
     * @notice Returns the list of all supported token addresses.
     * @dev The returned array is stored in contract state and may grow over time
     *      as new tokens are registered via admin configuration functions.
     * @return tokens An array of all currently supported token addresses.
     */
    function getSupportedTokens()
        external
        view
        returns (address[] memory tokens)
    {
        return supportedTokens;
    }

    // -----------------------------------------------------------------------
    // Public decimals helpers for converting assets with any amount of
    // decimals to 1e18 standardized USD format.
    // -----------------------------------------------------------------------

    /**
     * @notice Converts a token amount into USD (18 decimals)
     * @param token Token address
     * @param amount Raw token amount (native decimals)
     * @return usdValue USD value (18 decimals)
     */
    function toUSD(
        address token,
        uint256 amount
    ) external view returns (uint256 usdValue) {
        if (amount == 0) return 0;
        uint8 decimals = IERC20Metadata(token).decimals();
        uint256 normalized = (amount * UBKOracleConstants.WAD) /
            (10 ** decimals);
        uint256 price = _getPrice(token); // 18 decimals
        usdValue = (normalized * price) / UBKOracleConstants.WAD;
    }

    /**
     * @notice Converts a USD amount (18 decimals) into token units
     * @param token Token address
     * @param usdAmount USD value (18 decimals)
     * @return tokenAmount Equivalent in token units
     */
    function fromUSD(
        address token,
        uint256 usdAmount
    ) external view returns (uint256 tokenAmount) {
        if (usdAmount == 0) return 0;
        uint8 decimals = IERC20Metadata(token).decimals();
        uint256 price = _getPrice(token); // 18 decimals
        uint256 normalized = (usdAmount * UBKOracleConstants.WAD) / price;
        tokenAmount = (normalized * (10 ** decimals)) / UBKOracleConstants.WAD;
    }

    // -----------------------------------------------------------------------
    // Internal Helpers
    // -----------------------------------------------------------------------

    /**
     * @notice Returns the cached price for a token (1e18 precision).
     * @dev Reverts if no valid price or if staleness > stalePeriod.
     * @param token Asset token address.
     * @return price Cached price in 1e18 precision.
     */
    function _getPrice(address token) internal view returns (uint256) {
        if (token == address(0))
            revert ZeroAddress("UBKOracle::getPrice", "token");
        LastValidPrice memory lv = lastValidPrice[token];
        if (lv.price == 0) revert NoFallbackPrice(token);
        if (!_isPriceFresh(token))
            revert StalePrice(token, lv.timestamp, block.timestamp);
        return lv.price;
    }

    /**
     * @notice Checks if cached price is within freshness threshold.
     * @param token Token address.
     * @return isFresh True if price updated ≤ stalePeriod ago.
     */
    function _isPriceFresh(address token) internal view returns (bool isFresh) {
        LastValidPrice memory lv = lastValidPrice[token];
        return (lv.timestamp != 0 &&
            block.timestamp - lv.timestamp <= stalePeriod[token]);
    }

    /**
     * @notice Resolves the fair price of an ERC4626 vault share.
     * @param vault ERC4626 vault token address.
     * @param underlying Underlying asset used for valuation.
     * @return price Vault share price (1e18 precision).
     * @dev Derives price via convertToAssets() * underlying price.
     *      Ensures vault rate lies within acceptable bounds.
     */
    function _getVaultPrice(
        address vault,
        address underlying
    ) internal checkRecursion returns (uint256 price) {
        uint8 shareDecimals = IERC20Metadata(vault).decimals();
        uint8 underlyingDecimals = IERC20Metadata(underlying).decimals();

        uint256 oneShare = 10 ** shareDecimals;
        uint256 assetsPerShare = IERC4626(vault).convertToAssets(oneShare);
        if (assetsPerShare == 0 || assetsPerShare > 1e36)
            revert InvalidVaultExchangeRate(vault, assetsPerShare);

        uint256 scaledAssets = (assetsPerShare * UBKOracleConstants.WAD) /
            (10 ** underlyingDecimals);
        uint256 scaledShare = (oneShare * UBKOracleConstants.WAD) /
            (10 ** shareDecimals);
        uint256 rate = (scaledAssets * UBKOracleConstants.WAD) / scaledShare;

        VaultRateBounds memory bounds = vaultRateBounds[vault];
        uint256 minRate = bounds.minRate == 0
            ? UBKOracleConstants.ORACLE_MIN_VAULT_RATE_WAD
            : bounds.minRate;
        uint256 maxRate = bounds.maxRate == 0
            ? UBKOracleConstants.ORACLE_MAX_VAULT_RATE_WAD
            : bounds.maxRate;
        if (rate > maxRate || rate < minRate)
            revert SuspiciousVaultRate(vault, rate);

        uint256 underlyingPrice = _resolvePrice(underlying);
        return (underlyingPrice * rate) / UBKOracleConstants.WAD;
    }

    /**
     * @notice Fetches and validates the latest Chainlink feed price.
     * @param token The address of the token whose feed needs to be read.
     * @return price The normalized price (1e18 precision).
     * @return valid Boolean indicating whether the feed result is valid.
     *
     * @dev
     *  - Fetches `latestRoundData()` from the feed.
     *  - Checks for nonzero `answer` and `updatedAt` values.
     *  - Rejects stale prices older than `stalePeriod`.
     *  - Normalizes feed decimals to 18.
     *  - Ensures price lies within absolute oracle bounds.
     *
     *  If any condition fails or the feed call reverts, returns `(0, false)`.
     */
    function _getChainlinkPrice(
        address token
    ) internal view returns (uint256 price, bool valid) {
        address feed = chainlinkFeeds[token];
        try AggregatorV3Interface(feed).latestRoundData() returns (
            uint80,
            int256 answer,
            uint256,
            uint256 updatedAt,
            uint80
        ) {
            if (
                answer <= 0 ||
                updatedAt == 0 ||
                block.timestamp - updatedAt > stalePeriod[token]
            ) return (0, false);

            uint8 feedDecimals = AggregatorV3Interface(feed).decimals();
            uint256 raw = uint256(answer);

            uint256 clPrice;
            if (feedDecimals == 18) {
                clPrice = raw;
            } else if (feedDecimals < 18) {
                // multiply and scale up safely to 18 decimals
                clPrice = Math.mulDiv(raw, 10 ** (18 - feedDecimals), 1);
            } else {
                // scale down safely to 18 decimals
                clPrice = Math.mulDiv(raw, 1, 10 ** (feedDecimals - 18));
            }

            if (
                clPrice < UBKOracleConstants.ORACLE_MIN_ABSOLUTE_PRICE_WAD ||
                clPrice > UBKOracleConstants.ORACLE_MAX_ABSOLUTE_PRICE_WAD
            ) return (0, false);

            return (clPrice, true);
        } catch {
            return (0, false);
        }
    }

    /**
     * @notice Resolves a token's price using manual, ERC4626, or Chainlink sources.
     * @param token Token to resolve.
     * @return price Resolved fair price in 1e18 precision.
     * @dev May trigger state updates if underlying vaults are resolved.
     */
    function _resolvePrice(address token) internal returns (uint256 price) {
        if (isManual[token]) return manualPrices[token];

        address underlying = erc4626Underlying[token];
        if (underlying != address(0)) return _getVaultPrice(token, underlying);

        address feed = chainlinkFeeds[token];
        if (feed == address(0)) revert NoPriceFeed(token);

        (uint256 clPrice, bool valid) = _getChainlinkPrice(token);
        if (valid) return clPrice;

        LastValidPrice memory lv = lastValidPrice[token];
        if (lv.price == 0) revert NoFallbackPrice(token);
        if (block.timestamp - lv.timestamp > fallbackStalePeriod[token])
            revert StaleFallback(token);

        emit OracleFallbackUsed(
            token,
            lv.price,
            block.timestamp,
            "Chainlink failure"
        );
        return lv.price;
    }

    /**
     * @notice Fetches, validates, and stores the latest token price.
     * @param token Token address.
     * @return price Resolved and persisted price (1e18 precision).
     * @dev Updates lastValidPrice mapping and emits event.
     */
    function _fetchAndUpdatePrice(
        address token
    ) internal returns (uint256 price) {
        price = _resolvePrice(token);
        if (
            price < UBKOracleConstants.ORACLE_MIN_ABSOLUTE_PRICE_WAD ||
            price > UBKOracleConstants.ORACLE_MAX_ABSOLUTE_PRICE_WAD
        ) revert InvalidOraclePrice(token, address(0));

        lastValidPrice[token] = LastValidPrice(price, block.timestamp);
        emit LastValidPriceUpdated(token, price, block.timestamp);
        return price;
    }

    /**
     * @notice Adds a token to the supported tokens list if not already present.
     * @dev
     *  - Internal helper to register newly configured assets.
     *  - Ensures uniqueness via `isSupported` mapping.
     *  - Called from setup functions such as `setChainlinkFeed` or `setERC4626Vault`.
     * @param token The address of the token to add.
     *
     * Emits a {TokenSupportAdded} event upon successful addition.
     */
    function _addSupportedToken(address token) internal {
        if (!isSupported[token]) {
            supportedTokens.push(token);
            isSupported[token] = true;
            emit TokenSupportAdded(token);
        }
    }

    /**
     * @notice Validates assets and their associated Chainlink feeds before mutating system state.
     * @param token Asset token address.
     * @param feed Chainlink AggregatorV3 feed address.
     * @dev Ensures decimals ≤ 18 and feed returns a nonzero updatedAt value.
     */
    function _validateChainlinkFeed(address token, address feed) internal view {
        if (token == address(0))
            revert ZeroAddress("UBKOracle::setChainlinkFeed", "token");
        if (feed == address(0))
            revert ZeroAddress("UBKOracle::setChainlinkFeed", "feed");
        if (feed.code.length == 0) revert InvalidFeedContract(feed);
        _validateTokenDecimals(token);
    }

    /**
     * @notice Validates input parameters before setting an ERc 4626 vault.
     * @dev Ensures decimals for both assets are equal, and bounded by global invariants.
     * @param vault ERC-4626 asset.
     * @param underlying ERC-20 asset.
     */
    function _validateERC4626Vault(
        address vault,
        address underlying
    ) internal view {
        if (vault == address(0))
            revert ZeroAddress("UBKOracle::_validateERC4626Vault", "vault");
        if (underlying == address(0)) {
            revert ZeroAddress(
                "UBKOracle::_validateERC4626Vault",
                "underlying"
            );
        }
        try IERC4626(vault).asset() returns (address) {} catch {
            revert InvalidERC4626Vault(vault);
        }
        uint8 vaultDecimals = _validateTokenDecimals(vault); // Must be between [6,18]
        uint8 underlyingDecimals = _validateTokenDecimals(underlying); // Must be between [6,18]

        if (vaultDecimals != underlyingDecimals) {
            revert ERC4626DecimalsMismatch(
                "UBKOracle::_validateERC4626Vault",
                vault,
                underlying
            );
        }
    }
}
