// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, Token} from "./Contracts.t.sol";

interface Reactor {
    struct Output {
        address token;
        uint256 amount;
        address recipient;
    }

    struct Request {
        address tokenIn;
        uint256 amountIn;
        Output[] outputs;
        uint256 deadline;
        uint256 nonce;
        address protocol;
    }

    struct Order {
        Request request;
        bytes swapperSignature;
        address swapper;
        address filler;
        Output[] outputs;
    }

    struct Swap {
        address recipient;
        address tokenIn;
        uint256 amountIn;
        uint256 amountOut;
    }

    struct SwapInput {
        address adapter;
        Swap swap;
    }
    function LIQUID_LANE_ADAPTER_FACTORY() external view returns (address);
    function isUsedNonce(address, uint256) external view returns (bool);
    function invalidateNonce(uint256) external;
    function fill(Order calldata, bytes calldata, SwapInput[] calldata, bytes calldata) external;
}

interface Entities {
    function entity(uint256) external view returns (address);
}

contract ReactorFlowsTest is ForkBase {
    address internal constant TARGET = 0xC323B898d7E4105E3980082B74CC5D4602996B10;
    Reactor internal constant reactor = Reactor(TARGET);
    bytes32 internal constant OUTPUT = keccak256("Output(address token,uint256 amount,address recipient)");
    bytes32 internal constant REQUEST = keccak256(
        "Request(address tokenIn,uint256 amountIn,Output[] outputs,uint256 deadline,uint256 nonce,address protocol)Output(address token,uint256 amount,address recipient)"
    );
    bytes32 internal constant ORDER = keccak256(
        "Order(Request request,bytes swapperSignature,address swapper,address filler,Output[] outputs)Output(address token,uint256 amount,address recipient)Request(address tokenIn,uint256 amountIn,Output[] outputs,uint256 deadline,uint256 nonce,address protocol)"
    );
    uint256 internal protocolKey;
    uint256 internal callbacks;

    function test_InvalidateCallerNonce() public {
        assertFalse(reactor.isUsedNonce(alice, type(uint256).max));
        callAction(
            TARGET,
            alice,
            abi.encodeCall(reactor.invalidateNonce, (type(uint256).max)),
            "Reactor cancel maximum caller nonce"
        );
        assertTrue(reactor.isUsedNonce(alice, type(uint256).max));
        assertFalse(reactor.isUsedNonce(bob, type(uint256).max));
    }

    function test_RequestAndOrderSignaturesConsumedByRealReactor() public {
        address protocol;
        (protocol, protocolKey) = makeAddrAndKey("erc7730-fork-protocol");
        Reactor.Output[] memory requested = new Reactor.Output[](2);
        requested[0] = Reactor.Output(USDC, 100e6, carol);
        requested[1] = Reactor.Output(address(0), 0.05 ether, bob);
        Reactor.Request memory request =
            Reactor.Request(USDC, 100e6, requested, vm.getBlockTimestamp() + 1 days, 732, protocol);
        bytes memory swapperSignature = sign(aliceKey, hashRequest(request));
        Reactor.Output[] memory committed = new Reactor.Output[](2);
        committed[0] = Reactor.Output(USDC, 200e6, carol);
        committed[1] = Reactor.Output(address(0), 0.1 ether, bob);
        Reactor.Order memory order = Reactor.Order(request, swapperSignature, alice, address(this), committed);
        bytes memory protocolSignature = sign(protocolKey, hashOrder(order));
        address factory = reactor.LIQUID_LANE_ADAPTER_FACTORY();
        address adapter = Entities(factory).entity(0);
        Reactor.SwapInput[] memory inputs = new Reactor.SwapInput[](1);
        inputs[0] = Reactor.SwapInput(adapter, Reactor.Swap(address(this), USDC, 100e6, 200e6));
        fundAndApprove(USDC, TARGET, 100e6);
        deal(USDC, address(this), 200e6);
        Token(USDC).approve(TARGET, 200e6);
        vm.deal(address(this), 1 ether);
        uint256 adapterBefore = Token(USDC).balanceOf(adapter);
        uint256 outputBefore = Token(USDC).balanceOf(carol);
        uint256 nativeBefore = bob.balance;

        vm.expectRevert(bytes4(keccak256("InvalidFiller()")));
        vm.prank(bob);
        reactor.fill(order, protocolSignature, inputs, "");
        order.outputs[0].recipient = alice;
        vm.expectRevert(bytes4(keccak256("InvalidProtocolSignature()")));
        reactor.fill(order, protocolSignature, inputs, "");
        order.outputs[0].recipient = carol;
        order.swapperSignature = sign(protocolKey, hashRequest(request));
        bytes memory badSwapperOrderSignature = sign(protocolKey, hashOrder(order));
        vm.expectRevert(bytes4(keccak256("InvalidProtocolSignature()")));
        reactor.fill(order, badSwapperOrderSignature, inputs, "");
        order.swapperSignature = swapperSignature;
        assertFalse(reactor.isUsedNonce(alice, request.nonce));

        // This minimal local filler supplies the outputs. Reactor, tokens and registered adapter bytecode are unchanged.
        // The test validates Reactor authorization and transfers, not adapter routing or off-chain RFQ settlement.
        reactor.fill(order, protocolSignature, inputs, "");
        assertEq(callbacks, 1);
        assertEq(Token(USDC).balanceOf(alice), 0);
        assertEq(Token(USDC).balanceOf(adapter) - adapterBefore, 100e6);
        assertEq(Token(USDC).balanceOf(carol) - outputBefore, 200e6);
        assertEq(bob.balance - nativeBefore, 0.1 ether);
        assertTrue(reactor.isUsedNonce(alice, request.nonce));
        vm.serializeString("signed", "description", "Request and Order accepted by real Reactor fill");
        vm.serializeBytes("signed", "order", abi.encode(order));
        string memory signedRow = vm.serializeBytes("signed", "protocolSignature", protocolSignature);
        vm.writeLine("fork-signed-orders.jsonl", signedRow);
        vm.expectRevert(bytes4(keccak256("NonceUsed()")));
        reactor.fill(order, protocolSignature, inputs, "");
        vm.warp(request.deadline + 1);
        vm.expectRevert(bytes4(keccak256("ExpiredRequest()")));
        reactor.fill(order, protocolSignature, inputs, "");
    }

    function hashOutputs(Reactor.Output[] memory outputs) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](outputs.length);
        for (uint256 i; i < outputs.length; ++i) {
            hashes[i] = keccak256(abi.encode(OUTPUT, outputs[i]));
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function hashRequest(Reactor.Request memory request) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                REQUEST,
                request.tokenIn,
                request.amountIn,
                hashOutputs(request.outputs),
                request.deadline,
                request.nonce,
                request.protocol
            )
        );
    }

    function hashOrder(Reactor.Order memory order) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ORDER,
                hashRequest(order.request),
                keccak256(order.swapperSignature),
                order.swapper,
                order.filler,
                hashOutputs(order.outputs)
            )
        );
    }

    function sign(uint256 key, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Reactor"),
                keccak256("1"),
                block.chainid,
                TARGET
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    fallback() external payable {
        require(msg.sender == TARGET);
        callbacks++;
        (bool ok,) = TARGET.call{value: 0.1 ether}("");
        require(ok);
    }
    receive() external payable {}
}
