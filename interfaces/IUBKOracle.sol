// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IUBKOracle {
    // -----------------------------------------------------------------------
    // ENUMS & STRUCTS
    // -----------------------------------------------------------------------

    /// @notice Operational state of the oracle.
    enum OracleMode {
        NORMAL,
        PAUSED
    }

    /// @notice Cached last valid price and timestamp.
    struct LastValidPrice {
        uint256 price;
        uint256 timestamp;
    }

    /// @notice Vault-specific allowable min/max exchange rates.
    struct VaultRateBounds {
        uint256 minRate;
        uint256 maxRate;
    }

    // -----------------------------------------------------------------------
    // EVENTS (for Subgraph indexing)
    // -----------------------------------------------------------------------

    event ChainlinkFeedSet(address indexed token, address indexed feed);
    event ERC4626Registered(address indexed vault, address indexed underlying);
    event TokenSupportAdded(address indexed token);

    event ManualPriceSet(address indexed token, uint256 price);
    event ManualModeEnabled(address indexed token, bool enabled);

    event StalePeriodUpdated(address indexed token, uint256 newPeriod);
    event FallbackStalePeriodUpdated(address indexed token, uint256 newPeriod);

    event OracleModeChanged(OracleMode oldMode, OracleMode newMode);

    event VaultRateBoundsSet(
        address indexed vault,
        uint256 minRate,
        uint256 maxRate
    );

    event LastValidPriceUpdated(
        address indexed token,
        uint256 price,
        uint256 timestamp
    );

    event OracleFallbackUsed(
        address indexed token,
        uint256 lastValid,
        uint256 at,
        string reason
    );

    // -----------------------------------------------------------------------
    // VIEW PRICING API (Consumer-facing)
    // -----------------------------------------------------------------------

    /**
     * @notice Returns the cached fair price for a token (1e18 precision).
     * @dev Reverts if the price is stale or no valid price exists.
     */
    function getPrice(address token) external view returns (uint256);

    /**
     * @notice Converts a token amount (native decimals) into USD value (1e18).
     */
    function toUSD(
        address token,
        uint256 amount
    ) external view returns (uint256 usdValue);

    /**
     * @notice Converts a USD amount (1e18) into token units (native decimals).
     */
    function fromUSD(
        address token,
        uint256 usdAmount
    ) external view returns (uint256 tokenAmount);

    /**
     * @notice Returns the list of all supported token addresses.
     * @return tokens An array of all currently supported token addresses.
     */
    function getSupportedTokens()
        external
        view
        returns (address[] memory tokens);

    // -----------------------------------------------------------------------
    // KEEPER / MUTATOR FUNCTIONS
    // -----------------------------------------------------------------------

    /**
     * @notice Fetches and resolves the token price, then persists it as lastValidPrice.
     * @dev Keeper entrypoint. May revert if price resolution fails.
     */
    function fetchAndUpdatePrice(address token) external returns (uint256);

    /**
     * @notice Batch method for fetchAndUpdatePrice.
     * @dev Keeper entrypoint. May revert if price resolution fails.
     */
    function fetchAndUpdatePrice(
        address[] calldata tokens
    ) external returns (uint256[] memory);

    // -----------------------------------------------------------------------
    // ADMIN / GOVERNANCE CONFIGURATION
    // -----------------------------------------------------------------------

    /**
     * @notice Sets the operating mode of the oracle (NORMAL or PAUSED).
     * @dev PAUSED mode disables fetchAndUpdatePrice().
     */
    function setOracleMode(OracleMode newMode) external;

    /**
     * @notice Sets the maximum allowed staleness for Chainlink feed data.
     */
    function setStalePeriod(address token, uint256 period) external;

    /**
     * @notice Sets the fallback staleness threshold for relying on lastValidPrice.
     */
    function setFallbackStalePeriod(address token, uint256 period) external;

    /**
     * @notice Defines allowable min/max ERC4626 exchange rate bounds for a vault.
     */
    function setVaultRateBounds(
        address vault,
        uint256 minRate,
        uint256 maxRate
    ) external;

    /**
     * @notice Manually sets a token's price (1e18), constrained by ±10% of lastValidPrice.
     */
    function setManualPrice(address token, uint256 price) external;

    /**
     * @notice Disables manual pricing mode for a token.
     */
    function disableManualPrice(address token) external;

    /**
     * @notice Registers or updates a Chainlink feed for a token.
     */
    function setChainlinkFeed(address token, address feed) external;

    /**
     * @notice Registers an ERC4626 vault and its underlying token for valuation.
     */
    function setERC4626Vault(address vault, address underlying) external;
}
