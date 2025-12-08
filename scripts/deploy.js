const { ethers } = require("hardhat");

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying UBKOracle with:", deployer.address);

    const Oracle = await ethers.getContractFactory("UBKOracle");
    const oracle = await Oracle.deploy(deployer.address);

    await oracle.waitForDeployment();
    console.log("UBKOracle deployed to:", await oracle.getAddress());
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
