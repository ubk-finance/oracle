const { network } = require("hardhat");

const { TOKEN_ADDRESSES } = require("./tokens.js");
const { CHAINLINK_FEEDS } = require("./feeds.js");
const { SAFE_OWNERS } = require("./owners.js");

function getNetworkConfig() {
    const net = network.name;

    if (!TOKEN_ADDRESSES.ETH_MAIN && !TOKEN_ADDRESSES.ARB_ONE) {
        throw new Error("Token config missing");
    }

    if (net === "mainnet") {
        return {
            name: net,
            tokens: TOKEN_ADDRESSES.ETH_MAIN,
            feeds: CHAINLINK_FEEDS.ETH_MAIN,
            safe: SAFE_OWNERS.mainnet,
        };
    }

    if (net === "arbitrum") {
        return {
            name: net,
            tokens: TOKEN_ADDRESSES.ARB_ONE,
            feeds: CHAINLINK_FEEDS.ARB_ONE,
            safe: SAFE_OWNERS.arbitrum,
        };
    }

    if (net === "hardhat" || net === "localhost") {
        return {
            name: net,
            tokens: TOKEN_ADDRESSES.ETH_MAIN,   // use mainnet config by default
            feeds: CHAINLINK_FEEDS.ETH_MAIN,
            safe: SAFE_OWNERS.hardhat,
        };
    }

    throw new Error(`Unsupported network: ${net}`);
}

module.exports = {
    getNetworkConfig
}