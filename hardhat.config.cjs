require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();
require("solidity-coverage");

const { PRIVATE_KEY } = process.env;

module.exports = {
    solidity: {
        version: "0.8.21",
        settings: {
            optimizer: {
                enabled: true,
                runs: 200,
            },
        },
    },

    defaultNetwork: "hardhat",

    networks: {
        hardhat: {},

        localhost: {
            url: "http://127.0.0.1:8545",
        },

        mainnet: {
            url: process.env.MAINNET_RPC_URL || "https://eth.llamarpc.com",
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
            chainId: 1,
        },
    },

    etherscan: {
        apiKey: process.env.ETHERSCAN_API_KEY || "",
    },

    paths: {
        sources: "./contracts",
        tests: "./test",
        cache: "./cache",
        artifacts: "./artifacts",
    },

    mocha: {
        timeout: 30000,
    },
};
