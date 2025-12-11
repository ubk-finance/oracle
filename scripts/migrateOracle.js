// migrateOracle.js
//
// Usage:
//   node migrateOracle.js 0xOLD_ORACLE 0xNEW_ORACLE --network mainnet
//

const hre = require("hardhat");
const { ethers } = hre;

async function main() {
    const [signer] = await ethers.getSigners();

    const from = "0x37814FAA5bd659888380CBa070F098Cc0999A8cA";
    const to = "0x5d4747d514B529005F4014f26068E1f4Ec47E06B";

    if (!from || !to) {
        console.error("Usage: node migrateOracle.js <fromOracle> <toOracle>");
        process.exit(1);
    }

    console.log(`\n🔄 UBK Oracle Migration`);
    console.log(`   FROM: ${from}`);
    console.log(`   TO:   ${to}`);
    console.log(`   Signer: ${signer.address}\n`);

    const Oracle = await ethers.getContractFactory("UBKOracle");

    const oldOracle = Oracle.attach(from);
    const newOracle = Oracle.attach(to);

    // ------------------------------------------------------------------
    // 1. Load supported tokens
    // ------------------------------------------------------------------
    const tokens = await oldOracle.getSupportedTokens();
    console.log(`📌 Found ${tokens.length} supported tokens:\n${tokens.join("\n")}\n`);

    // ------------------------------------------------------------------
    // 2. Copy Chainlink feeds
    // ------------------------------------------------------------------
    console.log(`⛓️  Copying Chainlink feeds...`);
    for (const tok of tokens) {
        const feed = await oldOracle.chainlinkFeeds(tok);
        if (feed !== ethers.ZeroAddress) {
            console.log(` → ${tok} → feed ${feed}`);
            const tx = await newOracle.connect(signer).setChainlinkFeed(tok, feed);
            await tx.wait();
        }
    }

    // ------------------------------------------------------------------
    // 3. Copy ERC4626 underlyings
    // ------------------------------------------------------------------
    console.log(`\n🏦 Copying ERC4626 vault mappings...`);
    for (const tok of tokens) {
        const underlying = await oldOracle.erc4626Underlying(tok);
        if (underlying !== ethers.ZeroAddress) {
            console.log(` → ${tok} → underlying ${underlying}`);
            const tx = await newOracle.connect(signer).setERC4626Vault(tok, underlying);
            await tx.wait();
        }
    }

    // ------------------------------------------------------------------
    // 4. Copy stalePeriod
    // ------------------------------------------------------------------
    console.log(`\n⏱️  Copying stalePeriod...`);
    for (const tok of tokens) {
        const sp = await oldOracle.stalePeriod(tok);
        if (sp > 0n) {
            console.log(` → ${tok} → stalePeriod: ${sp}`);
            const tx = await newOracle.connect(signer).setStalePeriod(tok, sp);
            await tx.wait();
        }
    }

    console.log(`\n✅ Migration complete! Oracle ${to} now mirrors ${from}.\n`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
