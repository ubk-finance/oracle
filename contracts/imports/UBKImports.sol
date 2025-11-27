// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// Importing these ensures Hardhat generates artifacts for them.
import "@ubk-labs/ubk-commons/contracts/mocks/MockERC20.sol";
import "@ubk-labs/ubk-commons/contracts/mocks/MockERC4626.sol";
import "@ubk-labs/ubk-commons/contracts/mocks/MockAggregatorV3.sol";

abstract contract UBKImports {
    /**
    This shim file will import all external contracts to enable 
    automatic artifact generation by HardHat.
     */
}
