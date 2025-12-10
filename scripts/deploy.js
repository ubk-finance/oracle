const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const { getNetworkConfig } = require("./config/utils");
const ONE_DAY = 24 * 60 * 60; //24 hours in seconds. Default stale period.

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

    const oracle = await Oracle.deploy(
        deployer.address,
        { gasLimit: 2500000 }    // << add this
    ); await oracle.waitForDeployment();

    const oracleAddr = await oracle.getAddress();
    console.log(`✅ UBKOracle deployed at: ${oracleAddr}\n`);

    // ---------------------------------------------------------
    // Save deployment to JSON
    // ---------------------------------------------------------
    const deploymentsDir = path.join(__dirname, "deployments");
    const outputFile = path.join(deploymentsDir, `${cfg.name}.json`);

    // ensure directory exists
    if (!fs.existsSync(deploymentsDir)) {
        fs.mkdirSync(deploymentsDir);
    }

    // object to write
    const deploymentData = {
        UBKOracle: oracleAddr
    };

    // write JSON
    fs.writeFileSync(outputFile, JSON.stringify(deploymentData, null, 4));

    console.log(`💾 Deployment saved to: ${outputFile}\n`);

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
            const tx1 = await oracle.setChainlinkFeed(token, feed);
            await tx1.wait();

            const tx2 = await oracle.setStalePeriod(token, ONE_DAY);
            await tx2.wait();
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
            const tx1 = await oracle.setERC4626Vault(v.vault, v.underlying);
            await tx1.wait();

            const tx2 = await oracle.setStalePeriod(v.vault, ONE_DAY);
            await tx2.wait();

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
