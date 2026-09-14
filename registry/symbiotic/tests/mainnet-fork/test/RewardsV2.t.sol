// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, Token, Vault1} from "./Contracts.t.sol";
import {NetworkRegistry, MiddlewareService} from "./Rewards.t.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";

interface Owned {
    function owner() external view returns (address);
}

interface Delegated {
    function delegator() external view returns (address);
}

interface Delegator {
    function TYPE() external view returns (uint64);
    function operator() external view returns (address);
    function setOperatorNetworkShares(bytes32, address, uint256) external;
}

interface Curators {
    function getCurator(address) external view returns (address);
    function setCurator(address, address) external;
}

interface Fees {
    function setCuratorNetworkFee(address, address, bool, uint256) external;
    function setOperatorsNetworkFee(address, address, bool, uint256) external;
    function setProtocolFee(bytes32, bool, uint256) external;
}

interface Rewards2 {
    struct Leaf {
        address token;
        uint256 rewardeeType;
        uint256 amount;
        bytes32 rewardeeDataHash;
    }

    struct Distribution {
        uint48 timestamp;
        bytes32 merkleRoot;
    }

    struct TokenAmount {
        uint64 chainId;
        address token;
        uint256 amount;
    }
    function distributeVaultSnapshotRewards(bytes32, address, address, uint256, uint48, bytes calldata) external;
    function claimVaultSnapshotRewards(address, address, address, address, uint256, uint256, uint256, bytes[] calldata)
        external;
    function claimOperatorFees(address, address, address, address, uint256, uint256, uint256, bytes calldata) external;
    function claimCuratorFees(address, address, address) external;
    function claimProtocolFees(address, address) external returns (uint256);
    function claimRewards(address, address, bytes calldata) external;
    function claimCumulativeMerkleRewards(address, address, Leaf calldata, bytes32[] calldata, bytes32) external;
    function lastUnclaimedReward(address, address, address, address) external view returns (uint256);
    function lastUnclaimedOperatorReward(address, address, address, address) external view returns (uint256);
    function curatorFees(address, address) external view returns (uint256);
    function protocolFees(address) external view returns (uint256);
    function claimed(address, address, address, uint256) external view returns (uint256);
    function setProtocol(address) external;
    function setRewarder(address) external;
    function depositCumulativeMerkleRewards(address, address, uint256) external;
    function distributeCumulativeMerkleRewards(
        address,
        Distribution calldata,
        TokenAmount[] calldata,
        bytes calldata,
        bytes calldata
    ) external;
    function hashTypedDataV4CrossChain(bytes32) external view returns (bytes32);
}

contract RewardsV2FlowsTest is ForkBase {
    using stdStorage for StdStorage;
    address internal constant TARGET = 0xa13e65cA0FeFa52cCb9615108fF400EF4806866B;
    address internal constant CURATORS = 0xF75D8d8F790178F0d7F2ee7656874567d382C21e;
    address internal constant FEES = 0x3E5a669F673712Bf72De956608E89D36561cbAf1;
    Rewards2 internal constant rewards = Rewards2(TARGET);

    function test_SnapshotNetworkRestakeFees() public {
        snapshotFlow(0xc10A7f0AC6E3944F4860eE97a937C51572e3a1Da, 0);
    }

    function test_SnapshotOperatorSpecificFees() public {
        snapshotFlow(0x403fdB36Cb82786AC82A5cd3be8E9B922AF4949A, 2);
    }

    function test_SnapshotOperatorNetworkSpecificFees() public {
        snapshotFlow(0xF40eccdDb0056bAcd5328DBC8e532F9Ba73dAC74, 3);
    }

    function snapshotFlow(address vault, uint64 expectedType) internal {
        allowV1Deposit(vault);
        fundAndApprove(WSTETH, vault, 20e18);
        vm.prank(alice);
        Vault1(vault).deposit(alice, 10e18);
        vm.startPrank(alice);
        NetworkRegistry(0xC773b1011461e7314CF05f97d95aa8e92C1Fd8aA).registerNetwork();
        MiddlewareService(0xD7dC9B366c027743D90761F71858BCa83C6899Ad).setMiddleware(alice);
        vm.stopPrank();
        address curator = Curators(CURATORS).getCurator(vault);
        if (curator == address(0)) curator = Owned(vault).owner();
        vm.prank(curator);
        Curators(CURATORS).setCurator(vault, alice);
        vm.startPrank(alice);
        Fees(FEES).setCuratorNetworkFee(vault, alice, true, 100_000);
        Fees(FEES).setOperatorsNetworkFee(vault, alice, true, 100_000);
        vm.stopPrank();
        address feeOwner = Owned(FEES).owner();
        vm.prank(feeOwner);
        Fees(FEES).setProtocolFee(keccak256(abi.encode("rewards", uint64(0), alice)), true, 10_000);

        address delegator = Delegated(vault).delegator();
        assertEq(Delegator(delegator).TYPE(), expectedType);
        bytes32 subnetwork = bytes32(uint256(uint160(alice)) << 96);
        address operator = alice;
        if (expectedType == 0) {
            // Fork-only role setup; the real delegator writes and serves its own share checkpoints.
            stdstore.target(delegator)
                .sig("hasRole(bytes32,address)")
                .with_key(keccak256("OPERATOR_NETWORK_SHARES_SET_ROLE"))
                .with_key(alice)
                .checked_write(true);
            vm.prank(alice);
            Delegator(delegator).setOperatorNetworkShares(subnetwork, alice, 100);
        } else {
            operator = Delegator(delegator).operator();
        }
        uint48 timestamp = uint48(vm.getBlockTimestamp());
        vm.warp(vm.getBlockTimestamp() + 1);
        fundAndApprove(USDC, TARGET, 3000e6);
        for (uint256 i; i < 3; ++i) {
            vm.prank(alice);
            rewards.distributeVaultSnapshotRewards(subnetwork, USDC, vault, 1000e6, timestamp, "");
        }

        bytes[] memory hints = new bytes[](1);
        hints[0] = abi.encode(uint32(0));
        uint256 beforeBalance = Token(USDC).balanceOf(bob);
        // Starting at index 1 permanently skips index 0, even though expected index is 0.
        callAction(
            TARGET,
            alice,
            abi.encodeCall(rewards.claimVaultSnapshotRewards, (bob, alice, USDC, vault, 0, 1, 1, hints)),
            "V2 snapshot claim skips earlier reward"
        );
        assertGt(Token(USDC).balanceOf(bob), beforeBalance);
        assertEq(rewards.lastUnclaimedReward(alice, vault, alice, USDC), 2);
        bytes[] memory emptyHints = new bytes[](0);
        vm.expectRevert(bytes4(keccak256("InvalidLastUnclaimedReward()")));
        vm.prank(alice);
        rewards.claimVaultSnapshotRewards(bob, alice, USDC, vault, 0, 0, 1, emptyHints);
        beforeBalance = Token(USDC).balanceOf(bob);
        bytes memory data = abi.encodePacked(
            uint64(0), abi.encode(alice, vault, uint256(2), uint256(0), type(uint256).max, emptyHints)
        );
        callAction(
            TARGET,
            alice,
            abi.encodeCall(rewards.claimRewards, (bob, USDC, data)),
            "V2 unified snapshot claims remaining reward"
        );
        assertGt(Token(USDC).balanceOf(bob), beforeBalance);
        assertEq(rewards.lastUnclaimedReward(alice, vault, alice, USDC), 3);

        beforeBalance = Token(USDC).balanceOf(bob);
        callAction(
            TARGET,
            operator,
            abi.encodeCall(rewards.claimOperatorFees, (bob, alice, USDC, vault, 0, 0, 1, abi.encode(hints, hints))),
            "V2 operator fee with valid checkpoint hints"
        );
        assertGt(Token(USDC).balanceOf(bob), beforeBalance);
        assertEq(rewards.lastUnclaimedOperatorReward(operator, vault, alice, USDC), 1);
        callAction(
            TARGET,
            operator,
            abi.encodeCall(rewards.claimOperatorFees, (bob, alice, USDC, vault, 1, 2, type(uint256).max, bytes(""))),
            "V2 operator skip and maximum count"
        );
        assertEq(rewards.lastUnclaimedOperatorReward(operator, vault, alice, USDC), 3);

        uint256 fees = rewards.curatorFees(vault, USDC);
        assertGt(fees, 0);
        beforeBalance = Token(USDC).balanceOf(carol);
        vm.expectRevert(bytes4(keccak256("NotCurator()")));
        vm.prank(bob);
        rewards.claimCuratorFees(carol, vault, USDC);
        callAction(
            TARGET,
            alice,
            abi.encodeCall(rewards.claimCuratorFees, (carol, vault, USDC)),
            "V2 authorized curator fee claim"
        );
        assertEq(Token(USDC).balanceOf(carol) - beforeBalance, fees);
        assertEq(rewards.curatorFees(vault, USDC), 0);

        fees = rewards.protocolFees(USDC);
        assertGt(fees, 0);
        beforeBalance = Token(USDC).balanceOf(carol);
        address rewardsOwner = Owned(TARGET).owner();
        callAction(
            TARGET,
            rewardsOwner,
            abi.encodeCall(rewards.claimProtocolFees, (carol, USDC)),
            "V2 authorized protocol fee claim"
        );
        assertEq(Token(USDC).balanceOf(carol) - beforeBalance, fees);
        assertEq(rewards.protocolFees(USDC), 0);
    }

    function test_MerkleCumulativeDeltaAndUnifiedClaim() public {
        address owner = Owned(TARGET).owner();
        vm.prank(owner);
        rewards.setProtocol(alice);
        vm.prank(alice);
        rewards.setRewarder(alice);
        fundAndApprove(USDC, TARGET, 1000e6);
        vm.prank(alice);
        rewards.depositCumulativeMerkleRewards(alice, USDC, 1000e6);
        Rewards2.Leaf memory leaf = Rewards2.Leaf(USDC, 2, 100e6, keccak256("fork reward metadata"));
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = keccak256("another leaf");
        bytes32 root = publishRoot(leaf, proof[0], uint48(vm.getBlockTimestamp()));
        uint256 beforeBalance = Token(USDC).balanceOf(bob);
        callAction(
            TARGET,
            alice,
            abi.encodeCall(rewards.claimCumulativeMerkleRewards, (bob, alice, leaf, proof, root)),
            "V2 Merkle first cumulative entitlement"
        );
        assertEq(Token(USDC).balanceOf(bob) - beforeBalance, 100e6);
        assertEq(rewards.claimed(alice, USDC, alice, 2), 100e6);
        vm.expectRevert(bytes4(keccak256("NoCumulativeRewardsToClaim()")));
        vm.prank(alice);
        rewards.claimCumulativeMerkleRewards(bob, alice, leaf, proof, root);

        leaf.amount = 150e6;
        root = publishRoot(leaf, proof[0], uint48(vm.getBlockTimestamp() + 1));
        beforeBalance = Token(USDC).balanceOf(bob);
        callAction(
            TARGET,
            alice,
            abi.encodeCall(rewards.claimCumulativeMerkleRewards, (bob, alice, leaf, proof, root)),
            "V2 Merkle 150 total entitlement pays only 50"
        );
        assertEq(Token(USDC).balanceOf(bob) - beforeBalance, 50e6);
        leaf.amount = 200e6;
        root = publishRoot(leaf, proof[0], uint48(vm.getBlockTimestamp() + 2));
        bytes memory data = abi.encodePacked(uint64(1), abi.encode(alice, root, leaf, proof));
        beforeBalance = Token(USDC).balanceOf(carol);
        callAction(
            TARGET,
            alice,
            abi.encodeCall(rewards.claimRewards, (carol, USDC, data)),
            "V2 unified Merkle claim pays cumulative difference"
        );
        assertEq(Token(USDC).balanceOf(carol) - beforeBalance, 50e6);
        assertEq(rewards.claimed(alice, USDC, alice, 2), 200e6);
    }

    function publishRoot(Rewards2.Leaf memory leaf, bytes32 sibling, uint48 timestamp) internal returns (bytes32 root) {
        bytes32 hash = keccak256(abi.encode(alice, block.chainid, leaf));
        root = hash < sibling ? keccak256(abi.encodePacked(hash, sibling)) : keccak256(abi.encodePacked(sibling, hash));
        Rewards2.Distribution memory distribution = Rewards2.Distribution(timestamp, root);
        Rewards2.TokenAmount[] memory amounts = new Rewards2.TokenAmount[](1);
        amounts[0] = Rewards2.TokenAmount(uint64(block.chainid), leaf.token, leaf.amount);
        bytes32 tokenHash =
            keccak256(abi.encode(keccak256("TokenAmount(uint64 chainId,address token,uint256 amount)"), amounts[0]));
        bytes32 typeHash = keccak256(
            "CumulativeDistributionPayload(address network,uint48 timestamp,bytes32 merkleRoot,TokenAmount[] totalAmounts)TokenAmount(uint64 chainId,address token,uint256 amount)"
        );
        bytes32 digest = rewards.hashTypedDataV4CrossChain(
            keccak256(abi.encode(typeHash, alice, distribution, keccak256(abi.encodePacked(tokenHash))))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);
        rewards.distributeCumulativeMerkleRewards(alice, distribution, amounts, signature, signature);
    }
}
