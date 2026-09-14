// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, Token, Vault1} from "./Contracts.t.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";

interface NetworkRegistry {
    function registerNetwork() external;
}

interface MiddlewareService {
    function setMiddleware(address) external;
}

interface LegacyRewards {
    function VAULT() external view returns (address);
    function ADMIN_FEE_BASE() external view returns (uint256);
    function ADMIN_FEE_CLAIM_ROLE() external view returns (bytes32);
    function lastUnclaimedReward(address, address, address) external view returns (uint256);
    function claimableAdminFee(address) external view returns (uint256);
    function distributeRewards(address, address, uint256, bytes calldata) external;
    function claimRewards(address, address, bytes calldata) external;
    function claimAdminFee(address, address) external;
}

contract LegacyRewardsFlowsTest is ForkBase {
    using stdStorage for StdStorage;
    address internal constant NETWORK_REGISTRY = 0xC773b1011461e7314CF05f97d95aa8e92C1Fd8aA;
    address internal constant MIDDLEWARE = 0xD7dC9B366c027743D90761F71858BCa83C6899Ad;

    function test_RewardsContractVersion1() public {
        legacyFlow(0xA6159a6fD3F0f83A50DA52924869cfa8a3F7B969);
    }

    function test_RewardsContractVersion2() public {
        legacyFlow(0x2A3E7F5F113dC3BF6623ACf5095F816CEA48a698);
    }

    function legacyFlow(address target) internal {
        LegacyRewards rewards = LegacyRewards(target);
        address vault = rewards.VAULT();
        allowV1Deposit(vault);
        address collateral = Vault1(vault).collateral();
        uint256 unit = 10 ** uint256(Token(collateral).decimals());
        fundAndApprove(collateral, vault, 20 * unit);
        vm.prank(alice);
        Vault1(vault).deposit(alice, 10 * unit);
        vm.startPrank(alice);
        NetworkRegistry(NETWORK_REGISTRY).registerNetwork();
        MiddlewareService(MIDDLEWARE).setMiddleware(alice);
        vm.stopPrank();
        uint48 timestamp = uint48(vm.getBlockTimestamp());
        vm.warp(vm.getBlockTimestamp() + 1);

        // Fork-only setup: assign an admin claim role and a nonzero fee through the verified storage layout.
        vm.store(target, bytes32(uint256(1)), bytes32(rewards.ADMIN_FEE_BASE() / 10));
        stdstore.target(target)
            .sig("hasRole(bytes32,address)")
            .with_key(rewards.ADMIN_FEE_CLAIM_ROLE())
            .with_key(alice)
            .checked_write(true);
        fundAndApprove(USDC, target, 2000e6);
        bytes memory distribution = abi.encode(timestamp, type(uint256).max, bytes(""), bytes(""));
        vm.prank(alice);
        rewards.distributeRewards(alice, USDC, 1000e6, distribution);
        vm.prank(alice);
        rewards.distributeRewards(alice, USDC, 1000e6, distribution);
        uint256 beforeBalance = Token(USDC).balanceOf(bob);
        bytes[] memory hints = new bytes[](0);
        callAction(
            target,
            alice,
            abi.encodeCall(rewards.claimRewards, (bob, USDC, abi.encode(alice, uint256(1), hints))),
            "Legacy rewards first distribution"
        );
        assertGt(Token(USDC).balanceOf(bob), beforeBalance);
        assertEq(rewards.lastUnclaimedReward(alice, USDC, alice), 1);
        beforeBalance = Token(USDC).balanceOf(bob);
        callAction(
            target,
            alice,
            abi.encodeCall(rewards.claimRewards, (bob, USDC, abi.encode(alice, type(uint256).max, hints))),
            "Legacy rewards maximum count claims remainder"
        );
        assertGt(Token(USDC).balanceOf(bob), beforeBalance);
        assertEq(rewards.lastUnclaimedReward(alice, USDC, alice), 2);
        uint256 fees = rewards.claimableAdminFee(USDC);
        assertGt(fees, 0);
        beforeBalance = Token(USDC).balanceOf(carol);
        callAction(target, alice, abi.encodeCall(rewards.claimAdminFee, (carol, USDC)), "Legacy admin fee claim");
        assertEq(Token(USDC).balanceOf(carol) - beforeBalance, fees);
        assertEq(rewards.claimableAdminFee(USDC), 0);
    }
}
