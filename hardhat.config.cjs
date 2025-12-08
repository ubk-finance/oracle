require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();
require("solidity-coverage");

const { PRIVATE_KEY, RPC_URL } = process.env;

module.exports = {
    solidity: {
        version: "0.8.21",
        settings: {
            optimizer: {
                enabled: true,
                runs: 200
            }
        }
    },
    defaultNetwork: "hardhat",
    networks: {
        hardhat: {},
        localhost: {
            url: "http://127.0.0.1:8545"
        },
        arbitrum: {
            url: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
        },
        arbitrumSepolia: {
            url: process.env.ARBSEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
        }

    },
    etherscan: {
        apiKey: {
            arbitrumOne: process.env.ARBISCAN_API_KEY || "",
            arbitrumSepolia: process.env.ARBISCAN_API_KEY || "",
        },
        customChains: [
            {
                network: "arbitrumOne",
                chainId: 42161,
                urls: {
                    apiURL: "https://api.arbiscan.io/api",
                    browserURL: "https://arbiscan.io"
                }
            },
            {
                network: "arbitrumSepolia",
                chainId: 421614,
                urls: {
                    apiURL: "https://api-sepolia.arbiscan.io/api",
                    browserURL: "https://sepolia.arbiscan.io"
                }
            }
        ]
    },
    paths: {
        sources: "./contracts",
        tests: "./test",
        cache: "./cache",
        artifacts: "./artifacts"
    },
    mocha: {
        timeout: 30000
    }
};