const { ethers } = require("hardhat");

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("📝 Deploying with account:", deployer.address);

    const Oracle = await ethers.getContractFactory("UBKOracle");
    console.log("⏳ Deploying UBKOracle...");

    // Deploy and wait for the transaction to be mined
    const oracle = await Oracle.deploy(deployer.address);

    // Wait for deployment to complete
    await oracle.waitForDeployment();

    const oracleAddr = await oracle.getAddress();
    console.log("✅ UBKOracle deployed at:", oracleAddr);

    // Optional: Wait for a few confirmations
    const deploymentTx = oracle.deploymentTransaction();
    if (deploymentTx) {
        await deploymentTx.wait(5); // Wait for 5 confirmations
        console.log("✅ Deployment confirmed with 5 blocks");
    }
}

main().catch((err) => {
    console.error("❌ FATAL ERROR:", err);
    process.exit(1);
});