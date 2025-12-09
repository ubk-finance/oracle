const { ethers, network } = require("hardhat");

// IMPORT CONFIG
const { TOKEN_ADDRESSES } = require("./config/tokens.js");
const { CHAINLINK_FEEDS } = require("./config/feeds.js");

// SAFE OWNERS PER NETWORK (expandable)
const SAFE_OWNERS = {
    mainnet: "0x8c97e0A2e37EFd2c052D4a420AbBa76dc9ea5AEF",
    arbitrum: "0x0000000000000000000000000000000000000002",// dummy
    hardhat: "0x0000000000000000000000000000000000000001", // dummy
};

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

async function main() {
    const cfg = getNetworkConfig();
    const [deployer] = await ethers.getSigners();

    console.log("\n===============================================");
    console.log(`🚀 UBK Oracle Deployment`);
    console.log(`Network: ${cfg.name}`);
    console.log(`Deployer: ${deployer.address}`);
    console.log(`Safe Owner: ${cfg.safe}`);
    console.log("===============================================\n");

    // ---------------------------------------------------------
    // 1. Deploy Oracle (EOA temporary owner)
    // ---------------------------------------------------------
    const Oracle = await ethers.getContractFactory("UBKOracle");
    console.log("⏳ Deploying UBKOracle...");

    const oracle = await Oracle.deploy(deployer.address);
    await oracle.waitForDeployment();

    const oracleAddr = await oracle.getAddress();
    console.log(`✅ UBKOracle deployed at: ${oracleAddr}\n`);

    // ---------------------------------------------------------
    // 2. Configure Chainlink Feeds
    // ---------------------------------------------------------
    console.log("===============================================");
    console.log("🔧 Setting Chainlink feeds...");
    console.log("===============================================\n");

    for (const symbol of Object.keys(cfg.feeds)) {
        const token = cfg.tokens[symbol];
        const feed = cfg.feeds[symbol];

        if (!token || !feed) {
            console.log(`⚠️  Skipping ${symbol} — missing mapping`);
            continue;
        }

        console.log(`→ Registering feed for ${symbol}`);
        try {
            const tx = await oracle.setChainlinkFeed(token, feed);
            await tx.wait();
            console.log(`   ✔️  ${symbol} feed set`);
        } catch (err) {
            console.log(`   ❌ Failed: ${symbol} — ${err.reason || err.message}`);
        }
    }

    // ---------------------------------------------------------
    // 3. ERC4626 VAULT REGISTRATION
    // ---------------------------------------------------------
    console.log("\n===============================================");
    console.log("🔧 Registering ERC4626 vaults...");
    console.log("===============================================\n");

    // Vault → underlying mapping (1:1 pure vaults)
    const VAULTS = {
        mainnet: [
            { vault: cfg.tokens.sfrxUSD, underlying: cfg.tokens.frxUSD },
            { vault: cfg.tokens.sUSDe, underlying: cfg.tokens.USDe },
            { vault: cfg.tokens.syrupUSDC, underlying: cfg.tokens.USDC },
        ],
        arbitrum: [
            // Add if any vaults exist on Arbitrum deployment
        ],
    }[cfg.name] || [];

    for (const v of VAULTS) {
        if (!v.vault || !v.underlying) {
            console.log(`⚠️ Skipping vault — missing mapping:`, v);
            continue;
        }

        console.log(`→ Setting vault ${v.vault} (→ underlying ${v.underlying})`);

        try {
            const tx = await oracle.setERC4626Vault(v.vault, v.underlying);
            await tx.wait();
            console.log(`   ✔️ Vault registered`);
        } catch (err) {
            console.log(`   ❌ Failed: ${err.reason || err.message}`);
        }
    }
    // ---------------------------------------------------------
    // 4. Transfer Ownership to Safe
    // ---------------------------------------------------------
    console.log("\n===============================================");
    console.log("🔐 Transferring ownership...");
    console.log("===============================================\n");

    try {
        const tx = await oracle.transferOwnership(cfg.safe);
        await tx.wait();
        console.log(`✅ Ownership transferred to Safe: ${cfg.safe}`);
    } catch (err) {
        console.log("❌ ERROR transferring ownership:", err.reason || err.message);
        console.log("⚠️ Oracle IS STILL OWNED BY THE DEPLOYER!");
    }

    console.log("\n🎉 Deployment Complete\n");
}

main().catch((err) => {
    console.error("❌ FATAL ERROR:", err);
    process.exit(1);
});
