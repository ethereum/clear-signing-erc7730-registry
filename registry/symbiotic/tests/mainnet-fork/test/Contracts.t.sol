// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

interface Token {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface Vault1 {
    function collateral() external view returns (address);
    function activeSharesOf(address) external view returns (uint256);
    function activeShares() external view returns (uint256);
    function activeStake() external view returns (uint256);
    function currentEpoch() external view returns (uint256);
    function epochDuration() external view returns (uint48);
    function withdrawalsOf(uint256, address) external view returns (uint256);
    function isWithdrawalsClaimed(uint256, address) external view returns (bool);
    function deposit(address, uint256) external returns (uint256, uint256);
    function withdraw(address, uint256) external returns (uint256, uint256);
    function redeem(address, uint256) external returns (uint256, uint256);
    function claim(address, uint256) external returns (uint256);
    function claimBatch(address, uint256[] calldata) external returns (uint256);
}

interface Vault2 is Token {
    function asset() external view returns (address);
    function withdrawalQueue() external view returns (address);
    function deposit(uint256, address) external returns (uint256);
    function mint(uint256, address) external returns (uint256);
    function withdraw(uint256, address, address) external returns (uint256);
    function redeem(uint256, address, address) external returns (uint256);
    function previewDeposit(uint256) external view returns (uint256);
    function nonces(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function permit(address, address, uint256, uint256, uint8, bytes32, bytes32) external;
}

interface Queue {
    function requestRedeem(uint256, address) external returns (uint256);
    function claim(uint256, address) external returns (uint256, uint256);
    function ownerOf(uint256) external view returns (address);
    function claimable(uint256) external view returns (uint256, uint256);
}

abstract contract ForkBase is Test {
    uint256 internal constant BLOCK = 25977595;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;
    address internal alice;
    address internal bob;
    address internal carol;
    uint256 internal aliceKey;

    function setUp() public virtual {
        vm.createSelectFork(vm.envOr("MAINNET_RPC_URL", string("https://eth.drpc.org")), BLOCK);
        (alice, aliceKey) = makeAddrAndKey("erc7730-fork-alice");
        bob = makeAddr("erc7730-fork-bob");
        carol = makeAddr("erc7730-fork-carol");
    }

    function callAction(address target, address sender, bytes memory data, string memory description)
        internal
        returns (bytes memory result)
    {
        vm.prank(sender);
        bool ok;
        (ok, result) = target.call(data);
        require(ok, string.concat(description, ": ", vm.toString(result)));
        vm.serializeString("action", "description", description);
        vm.serializeAddress("action", "to", target);
        vm.serializeAddress("action", "from", sender);
        vm.serializeUint("action", "forkBlock", BLOCK);
        vm.serializeBytes("action", "data", data);
        string memory row = vm.serializeBytes("action", "returnData", result);
        vm.writeLine("fork-actions.jsonl", row);
    }

    function fundAndApprove(address token, address spender, uint256 amount) internal {
        deal(token, alice, amount);
        vm.prank(alice);
        Token(token).approve(spender, type(uint256).max);
    }

    function allowV1Deposit(address target) internal {
        // Fork-only setup: clear the two deposit eligibility flags, preserving collateral and all accounting.
        // Verified Vault/VaultTokenized storage layout: slot 0 bytes 0/1, collateral begins at byte 2.
        address collateralBefore = Vault1(target).collateral();
        vm.store(target, bytes32(0), bytes32(uint256(vm.load(target, bytes32(0))) & ~uint256(0xffff)));
        assertEq(Vault1(target).collateral(), collateralBefore);
    }
}

contract VaultFlowsTest is ForkBase {
    function test_VaultVersion1() public {
        vault1Flow(0xF40eccdDb0056bAcd5328DBC8e532F9Ba73dAC74);
    }

    function test_VaultVersion2Tokenized() public {
        vault1Flow(0xc10A7f0AC6E3944F4860eE97a937C51572e3a1Da);
    }

    function vault1Flow(address target) internal {
        Vault1 v = Vault1(target);
        address token = v.collateral();
        allowV1Deposit(target);
        uint256 unit = 10 ** uint256(Token(token).decimals());
        fundAndApprove(token, target, 20 * unit);
        uint256 deposited = abi.decode(
            callAction(target, alice, abi.encodeCall(v.deposit, (alice, 10 * unit)), "V1 deposit"), (uint256)
        );
        assertEq(deposited, 10 * unit);
        assertGt(v.activeSharesOf(alice), 0);
        assertEq(Token(token).balanceOf(alice), 10 * unit);

        uint256 epoch = v.currentEpoch() + 1;
        uint256 originalShares = v.activeSharesOf(alice);
        callAction(target, alice, abi.encodeCall(v.withdraw, (bob, unit)), "V1 request asset withdrawal");
        assertLt(v.activeSharesOf(alice), originalShares);
        assertGt(v.withdrawalsOf(epoch, bob), 0);
        assertEq(Token(token).balanceOf(bob), 0);

        uint256 sharesToRedeem = v.activeSharesOf(alice) / 4;
        originalShares = v.activeSharesOf(alice);
        callAction(target, alice, abi.encodeCall(v.redeem, (alice, sharesToRedeem)), "V1 request share withdrawal");
        assertEq(v.activeSharesOf(alice), originalShares - sharesToRedeem);
        assertGt(v.withdrawalsOf(epoch, alice), 0);
        vm.warp(vm.getBlockTimestamp() + v.epochDuration());
        callAction(target, alice, abi.encodeCall(v.withdraw, (alice, unit)), "V1 request another epoch");
        vm.warp(vm.getBlockTimestamp() + 2 * uint256(v.epochDuration()));

        uint256 beforeBalance = Token(token).balanceOf(carol);
        uint256 claimed = abi.decode(
            callAction(target, bob, abi.encodeCall(v.claim, (carol, epoch)), "V1 claim to separate recipient"),
            (uint256)
        );
        assertGt(claimed, 0);
        assertEq(Token(token).balanceOf(carol) - beforeBalance, claimed);
        assertTrue(v.isWithdrawalsClaimed(epoch, bob));
        uint256[] memory epochs = new uint256[](2);
        epochs[0] = epoch;
        epochs[1] = epoch + 1;
        beforeBalance = Token(token).balanceOf(carol);
        claimed = abi.decode(
            callAction(target, alice, abi.encodeCall(v.claimBatch, (carol, epochs)), "V1 claim two epochs"), (uint256)
        );
        assertGt(claimed, 0);
        assertEq(Token(token).balanceOf(carol) - beforeBalance, claimed);
        assertTrue(v.isWithdrawalsClaimed(epoch, alice));
        assertTrue(v.isWithdrawalsClaimed(epoch + 1, alice));
    }

    function test_VaultV2AndQueue_Cassa() public {
        vault2Flow(0xCed027AdBF0966447b25E16f943A10780D5D1c08);
    }

    function test_VaultV2AndQueue_Presto() public {
        vault2Flow(0x4f7EA018239FfBdCf52133B9E98a498B2B4b9F32);
    }

    function test_VaultV2AndQueue_Keyrock() public {
        vault2Flow(0x007e0B8E99c6134E81A1eAAE754460E3202cB671);
    }

    function test_VaultV2AndQueue_KPK() public {
        vault2Flow(0x8BcD746976885b5832bAD07B4921E3f2dD1D3703);
    }

    function test_VaultV2AndQueue_Clearstar() public {
        vault2Flow(0x9902420048aEC155f1f1DF077f115595530Df216);
    }

    function test_VaultV2AndQueue_Amber() public {
        vault2Flow(0x9C8F48faD950D078AF0C6256Cb41e23B7185d142);
    }

    function test_VaultV2AndQueue_InfiniFi() public {
        vault2Flow(0x56097f1a378848A51F35e7D9Ca2592c444EC4637);
    }

    function vault2Flow(address target) internal {
        Vault2 v = Vault2(target);
        assertEq(v.asset(), USDC);
        assertEq(v.decimals(), 18);
        fundAndApprove(USDC, target, 1_000_000e6);
        uint256 expectedShares = v.previewDeposit(100e6);
        uint256 shares = abi.decode(
            callAction(target, alice, abi.encodeCall(v.deposit, (100e6, alice)), "V2 deposit assets"), (uint256)
        );
        assertEq(shares, expectedShares);
        assertEq(v.balanceOf(alice), shares);
        uint256 beforeAssets = Token(USDC).balanceOf(alice);
        // The deployed vaults have different exchange rates, including donations before their first deposit.
        uint256 sharesToMint = shares / 10;
        uint256 mintedAssets = abi.decode(
            callAction(target, alice, abi.encodeCall(v.mint, (sharesToMint, alice)), "V2 mint 18-decimal shares"),
            (uint256)
        );
        assertEq(v.balanceOf(alice), shares + sharesToMint);
        assertEq(beforeAssets - Token(USDC).balanceOf(alice), mintedAssets);

        callAction(target, alice, abi.encodeCall(v.approve, (bob, type(uint256).max)), "V2 unlimited share approval");
        assertEq(v.allowance(alice, bob), type(uint256).max);
        beforeAssets = Token(USDC).balanceOf(carol);
        uint256 beforeShares = v.balanceOf(alice);
        uint256 burned = abi.decode(
            callAction(target, bob, abi.encodeCall(v.withdraw, (1e6, carol, alice)), "V2 delegated withdrawal"),
            (uint256)
        );
        assertEq(Token(USDC).balanceOf(carol) - beforeAssets, 1e6);
        assertEq(beforeShares - v.balanceOf(alice), burned);
        beforeAssets = Token(USDC).balanceOf(carol);
        beforeShares = v.balanceOf(alice);
        uint256 sharesToRedeem = shares / 100;
        uint256 assets = abi.decode(
            callAction(
                target, bob, abi.encodeCall(v.redeem, (sharesToRedeem, carol, alice)), "V2 delegated redemption"
            ),
            (uint256)
        );
        assertEq(Token(USDC).balanceOf(carol) - beforeAssets, assets);
        assertEq(beforeShares - v.balanceOf(alice), sharesToRedeem);

        uint256 nonce = v.nonces(alice);
        uint256 deadline = vm.getBlockTimestamp() + 1 days;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                v.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                        alice,
                        bob,
                        7e18,
                        nonce,
                        deadline
                    )
                )
            )
        );
        (uint8 sigV, bytes32 r, bytes32 s) = vm.sign(aliceKey, digest);
        callAction(
            target,
            carol,
            abi.encodeCall(v.permit, (alice, bob, 7e18, deadline, sigV, r, s)),
            "V2 signed permit submitted by relayer"
        );
        assertEq(v.allowance(alice, bob), 7e18);
        assertEq(v.nonces(alice), nonce + 1);

        address queueAddress = v.withdrawalQueue();
        Queue q = Queue(queueAddress);
        uint256 sharesToQueue = shares / 20;
        vm.prank(alice);
        v.approve(queueAddress, sharesToQueue);
        beforeShares = v.balanceOf(alice);
        uint256 id = abi.decode(
            callAction(
                queueAddress,
                alice,
                abi.encodeCall(q.requestRedeem, (sharesToQueue, bob)),
                "Queue request sends NFT to beneficiary"
            ),
            (uint256)
        );
        assertEq(beforeShares - v.balanceOf(alice), sharesToQueue);
        assertEq(q.ownerOf(id), bob);
        (uint256 claimableAssets, uint256 claimableShares) = q.claimable(id);
        assertGt(claimableAssets, 0);
        beforeAssets = Token(USDC).balanceOf(carol);
        (assets, shares) = abi.decode(
            callAction(
                queueAddress, bob, abi.encodeCall(q.claim, (id, carol)), "Queue claim sends assets, retains NFT"
            ),
            (uint256, uint256)
        );
        assertEq(assets, claimableAssets);
        assertEq(shares, claimableShares);
        assertEq(Token(USDC).balanceOf(carol) - beforeAssets, assets);
        assertEq(q.ownerOf(id), bob);
    }
}
