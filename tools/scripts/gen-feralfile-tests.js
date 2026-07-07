#!/usr/bin/env node
/**
 * Generate comprehensive testsv2 fixtures for all Feral File descriptors.
 * Run: node tools/scripts/gen-feralfile-tests.js
 */

"use strict";
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// RLP encoding
// ---------------------------------------------------------------------------
function toBigEndian(n) {
  if (n === 0n) return Buffer.alloc(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.from(hex, "hex");
}
function rlpLen(len, base) {
  if (len < 56) return Buffer.from([base + len]);
  let hex = len.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const ll = Buffer.from(hex, "hex");
  return Buffer.concat([Buffer.from([base + 55 + ll.length]), ll]);
}
function rlp(x) {
  if (Buffer.isBuffer(x)) {
    if (x.length === 1 && x[0] < 0x80) return x;
    return Buffer.concat([rlpLen(x.length, 0x80), x]);
  }
  if (typeof x === "bigint") return rlp(toBigEndian(x));
  if (Array.isArray(x)) {
    const parts = x.map(rlp);
    const total = parts.reduce((s, b) => s + b.length, 0);
    return Buffer.concat([rlpLen(total, 0xc0), ...parts]);
  }
  throw new Error("rlp: unsupported type " + typeof x);
}

// ---------------------------------------------------------------------------
// ABI encoding helpers
// ---------------------------------------------------------------------------
const Z32 = "0".repeat(64);
const pad32 = (hex) => hex.replace("0x", "").toLowerCase().padStart(64, "0");
const encAddr = (a) => pad32(a);
const encUint = (n) => BigInt(n).toString(16).padStart(64, "0");
const encBool = (b) => (b ? "1" : "0").padStart(64, "0");
const encBytes32 = (h) => h.replace("0x", "").toLowerCase().padEnd(64, "0");
// Encode a UTF-8 string as ABI bytes (length + data padded to 32)
function encString(s) {
  const buf = Buffer.from(s, "utf8");
  const len = encUint(buf.length);
  const padded = buf.toString("hex").padEnd(Math.ceil(buf.length / 32) * 64, "0");
  return len + padded;
}
// Encode a dynamic bytes value
function encBytes(hex) {
  const raw = hex.replace("0x", "");
  const len = encUint(raw.length / 2);
  const padded = raw.padEnd(Math.ceil(raw.length / 64) * 64, "0");
  return len + padded;
}
// Encode a uint256[] (dynamic)
function encUintArray(arr) {
  const len = encUint(arr.length);
  return len + arr.map((v) => encUint(v)).join("");
}
// Encode an address[] (dynamic)
function encAddrArray(arr) {
  const len = encUint(arr.length);
  return len + arr.map(encAddr).join("");
}
// Encode a string[] (dynamic) — each string is dynamic inside
function encStringArray(arr) {
  // offsets + data
  const encoded = arr.map(encString);
  const baseOffset = arr.length * 32;
  let offsets = "";
  let cumOffset = baseOffset;
  for (const e of encoded) {
    offsets += encUint(cumOffset);
    cumOffset += e.length / 2;
  }
  return encUint(arr.length) + offsets + encoded.join("");
}

// Full ABI-encoded param block: offset pointer for a dynamic segment at `offset`
const ptr = (offset) => encUint(offset);

// ---------------------------------------------------------------------------
// Transaction builder
// ---------------------------------------------------------------------------
function buildTx({ to, value = 0n, data = "" }) {
  const dataBuf = data ? Buffer.from(data, "hex") : Buffer.alloc(0);
  const toBuf = Buffer.from(to.replace("0x", ""), "hex");
  const encoded = rlp([1n, 0n, 1000000000n, 20000000000n, 200000n, toBuf, value, dataBuf, []]);
  return "0x02" + encoded.toString("hex");
}

// ---------------------------------------------------------------------------
// Common constants
// ---------------------------------------------------------------------------
const ADDR_SENDER   = "0x0000000000000000000000000000000000000001"; // "Sender"
const ADDR_RECEIVER = "0x0000000000000000000000000000000000000003"; // "Receiver"
const ADDR_OPERATOR = "0x0000000000000000000000000000000000000002"; // "Test Operator"
const ADDR_VAULT    = "0x455464F0d369dAC13002e81e9fAB857f6aD21795"; // vault-0
const ADDR_VAULTV2  = "0xcBFaf4BDE69C9b37835761E5228f9fe9E25b452f"; // vault-v2-0
const ADDR_AUCTION  = "0xCE85Fa385A6d6F6c3B709cD7aa2DB116d3e1Ac6D";
const ADDR_AIRDROP  = "0x051E50D8465417e58899FD48C3b0Fc0CA3Dd4B6a";
const TOKEN_ID      = 1001n;
const TOKEN_ID2     = 2001n;
const ZERO_B32      = "0".repeat(64);
const V27           = encUint(27n);  // common sig v value

// Feral File exhibition contract addresses (first deployment per version)
const EXHIB = {
  v2:  "0x0A5c44da5F71B884c16A195CeC304F47ac0233CF",
  v3:  "0x6e82e4B398Ca4137007ba69ddD6FF699334d13b5",
  v3_2:"0x14a62abFEC0e09159fBE9c050F3B03044fC7ea52",
  v3_3:"0x2A86C5466f088caEbf94e071a77669BAe371CD87",
  v4:  "0x1D9787369B1DCf709f92Da1d8743c2A4b6028a83",
  v4_1:"0x115C9A6118bC7a3EB0aBD30f6BCF1C45Bb198AEd",
  v4_2:"0xBE0A4E26a156B2a60cF515E86b3Df9756DEE1952",
  v4_3:"0x81c882c59799eA442317D020c39174AaAa8d7FC7",
  v4_4:"0x614d5475FE81ef4b6Dd8093b5C73EfEEE03167e0",
  v4_5:"0x67E3ad1902A55074AAdD84d9b335105B2D52b813",
};

// dataProvider shared by most descriptors
function baseDataProvider(contractAddr, collectionName) {
  return {
    addressNames: {
      [ADDR_SENDER.toLowerCase()]:   "Sender",
      [ADDR_RECEIVER.toLowerCase()]: "Receiver",
      [ADDR_OPERATOR.toLowerCase()]: "Test Operator",
    },
    nftCollectionNames: {
      [contractAddr.toLowerCase()]: collectionName,
    },
  };
}

// ---------------------------------------------------------------------------
// Calldata builders — common functions shared across descriptors
// ---------------------------------------------------------------------------

// transferFrom(address from, address to, uint256 tokenId)   = 23b872dd
function cd_transferFrom(from, to, tokenId) {
  return "23b872dd" + encAddr(from) + encAddr(to) + encUint(tokenId);
}

// safeTransferFrom(address from, address to, uint256 tokenId)  = 42842e0e
function cd_safeTransferFrom3(from, to, tokenId) {
  return "42842e0e" + encAddr(from) + encAddr(to) + encUint(tokenId);
}

// safeTransferFrom(address from, address to, uint256 tokenId, bytes data) = b88d4fde
function cd_safeTransferFrom4(from, to, tokenId) {
  // head: from(32)+to(32)+tokenId(32)+data_offset(32=128=0x80)
  // tail: data length=0
  return (
    "b88d4fde" +
    encAddr(from) + encAddr(to) + encUint(tokenId) +
    encUint(128n) +  // offset to data (4 static slots * 32)
    encUint(0n)      // bytes length = 0
  );
}

// approve(address operator/to, uint256 tokenId) = 095ea7b3
function cd_approve(operator, tokenId) {
  return "095ea7b3" + encAddr(operator) + encUint(tokenId);
}

// setApprovalForAll(address operator, bool approved) = a22cb465
function cd_setApprovalForAll(operator, approved) {
  return "a22cb465" + encAddr(operator) + encBool(approved);
}

// burnArtworks(uint256[] tokenIds) = 21fe0c64
function cd_burnArtworks(tokenIds) {
  return "21fe0c64" + ptr(32n) + encUintArray(tokenIds);
}

// burnEditions(uint256[] editionIDs_) = fc05ea68
function cd_burnEditions(ids) {
  return "fc05ea68" + ptr(32n) + encUintArray(ids);
}

// mergeArtworks(uint256[] tokenIds) = c3714c69
function cd_mergeArtworks(tokenIds) {
  return "c3714c69" + ptr(32n) + encUintArray(tokenIds);
}

// startSale() = b66a0e5d
const cd_startSale = () => "b66a0e5d";
// pauseSale() = 55367ba9
const cd_pauseSale = () => "55367ba9";
// resumeSale() = 33e364cb
const cd_resumeSale = () => "33e364cb";
// stopSaleAndBurn() = b9b8311a
const cd_stopSaleAndBurn = () => "b9b8311a";

// stopSaleAndTransfer(uint256[] seriesIds, address[] recipientAddresses) = 65a46e08
function cd_stopSaleAndTransfer(seriesIds, recipients) {
  const head = encUint(64n) + encUint(BigInt(64 + 32 + seriesIds.length * 32));
  return "65a46e08" + head + encUintArray(seriesIds) + encAddrArray(recipients);
}

// setVault(address vault_) = 6817031b
const cd_setVault = (a) => "6817031b" + encAddr(a);
// setVaultV2(address vault_) = a74cebab
const cd_setVaultV2 = (a) => "a74cebab" + encAddr(a);
// setCostReceiver(address costReceiver_) = 1623528f
const cd_setCostReceiver = (a) => "1623528f" + encAddr(a);

// setTokenBaseURI(string baseURI_) = 8ef79e91
function cd_setTokenBaseURI(uri) {
  return "8ef79e91" + ptr(32n) + encString(uri);
}

// setAdvanceSetting(address[] addresses_, uint256[] amounts_) = 3c352b0d
function cd_setAdvanceSetting(addrs, amounts) {
  const addrOffset = 64n;
  const amtOffset = addrOffset + 32n + BigInt(addrs.length) * 32n;
  return (
    "3c352b0d" +
    encUint(addrOffset) + encUint(amtOffset) +
    encAddrArray(addrs) + encUintArray(amounts)
  );
}

// replaceAdvanceAddresses(address[] oldAddresses_, address[] newAddresses_) = 41a5626a
function cd_replaceAdvanceAddresses(oldAddrs, newAddrs) {
  const oldOffset = 64n;
  const newOffset = oldOffset + 32n + BigInt(oldAddrs.length) * 32n;
  return (
    "41a5626a" +
    encUint(oldOffset) + encUint(newOffset) +
    encAddrArray(oldAddrs) + encAddrArray(newAddrs)
  );
}

// mintArtworks((uint256 seriesId, uint256 tokenId, address owner)[] data) = 8cba1c67
// struct is all static (3 static fields), so the array encoding is:
//   offset(32) + length(32) + seriesId(32)+tokenId(32)+owner(32) per element
function cd_mintArtworks(entries) {
  // entries: [{seriesId, tokenId, owner}]
  const elems = entries.map(e =>
    encUint(e.seriesId) + encUint(e.tokenId) + encAddr(e.owner)
  ).join("");
  return "8cba1c67" + ptr(32n) + encUint(BigInt(entries.length)) + elems;
}

// buyArtworks(bytes32 r_, bytes32 s_, uint8 v_,
//   (uint256 price, uint256 cost, uint256 expiryTime, address destination,
//    uint256[] tokenIds, (address recipient, uint256 bps)[][] revenueShares,
//    bool payByVaultContract) saleData_)  = 2977e4b3
// saleData_ is dynamic (contains dynamic arrays), so it uses an offset pointer.
// With empty tokenIds [] and empty revenueShares [][], the tuple is dynamic.
function cd_buyArtworks(price, cost, expiryTime, destination, tokenIds, payByVault) {
  // Tuple fields: price(32) cost(32) expiryTime(32) destination(32)
  //   tokenIds_offset(32) revenueShares_offset(32) payByVaultContract(32)
  // Then tail of tuple: tokenIds array, revenueShares array
  // With tokenIds=[1001] revenueShares=[] (empty outer array):
  const tupleStaticSize = 7 * 32; // 7 static head slots
  const tokenIdsOffset = tupleStaticSize;             // 224 = 0xe0
  const revShareOffset = tupleStaticSize + 32 + tokenIds.length * 32; // after tokenIds
  const tupleHead =
    encUint(price) + encUint(cost) + encUint(expiryTime) +
    encAddr(destination) +
    encUint(BigInt(tokenIdsOffset)) + encUint(BigInt(revShareOffset)) +
    encBool(payByVault);
  const tupleTail = encUintArray(tokenIds) + encUintArray([]); // revenueShares = 0 elements
  const tupleEncoded = tupleHead + tupleTail;
  // saleData_ is the 4th param, encoded as a dynamic type with offset
  // static head of the function: r_(32) + s_(32) + v_(32) + saleData_offset(32)
  const saleDataOffset = 4 * 32; // 128 = 0x80
  return (
    "2977e4b3" +
    ZERO_B32 + ZERO_B32 + V27 +
    encUint(BigInt(saleDataOffset)) +
    tupleEncoded
  );
}

// buyBulkArtworks(bytes32 r_, bytes32 s_, uint8 v_,
//   (uint256 price, uint256 cost, uint256 expiryTime, address destination,
//    uint256 nonce, uint256 seriesID, uint16 quantity,
//    (address recipient, uint256 bps)[] revenueShares, bool payByVaultContract)) = 4bda5d89
// All fields in saleData_ are static except revenueShares (dynamic), so saleData_ is dynamic.
function cd_buyBulkArtworks(price, cost, expiryTime, destination, nonce, seriesID, quantity, payByVault) {
  const tupleStaticSize = 9 * 32; // 9 head slots
  const revShareOffset = tupleStaticSize; // empty revShares
  const tupleHead =
    encUint(price) + encUint(cost) + encUint(expiryTime) +
    encAddr(destination) +
    encUint(nonce) + encUint(seriesID) + encUint(BigInt(quantity)) +
    encUint(BigInt(revShareOffset)) +
    encBool(payByVault);
  const tupleTail = encUintArray([]); // empty revenueShares
  const tupleEncoded = tupleHead + tupleTail;
  const saleDataOffset = 4 * 32;
  return (
    "4bda5d89" +
    ZERO_B32 + ZERO_B32 + V27 +
    encUint(BigInt(saleDataOffset)) +
    tupleEncoded
  );
}

// setRoyaltyPayoutAddress(address royaltyPayoutAddress_) = 45aeefde
const cd_setRoyaltyPayoutAddress = (a) => "45aeefde" + encAddr(a);

// updateArtworkEditionIPFSCid(uint256 tokenId, string ipfsCID) = 0cfcb5f1
function cd_updateArtworkEditionIPFSCid(tokenId, cid) {
  return "0cfcb5f1" + encUint(tokenId) + ptr(64n) + encString(cid);
}

// createArtworks((string title, string artistName, string fingerprint, uint256 editionSize, uint256 AEAmount, uint256 PPAmount)[] artworks_) = 43deaf76
// Struct contains dynamic strings, so each struct is dynamic.
// Single artwork: title="Test", artistName="Artist", fingerprint="fp", editionSize=10, AEAmount=0, PPAmount=0
function cd_createArtworks() {
  // Single struct: 3 strings (dynamic) + 3 uint256 (static)
  // Struct head: title_offset(32) + artistName_offset(32) + fingerprint_offset(32) + editionSize(32) + AEAmount(32) + PPAmount(32) = 192
  const title = "Test Artwork";
  const artist = "Test Artist";
  const fingerprint = "fp_test_001";
  const titleEnc = encString(title);
  const artistEnc = encString(artist);
  const fpEnc = encString(fingerprint);
  const structHeadSize = 6 * 32; // 192
  const titleOffset = structHeadSize;
  const artistOffset = titleOffset + titleEnc.length / 2;
  const fpOffset = artistOffset + artistEnc.length / 2;
  const structHead =
    encUint(BigInt(titleOffset)) + encUint(BigInt(artistOffset)) + encUint(BigInt(fpOffset)) +
    encUint(10n) + encUint(0n) + encUint(0n);
  const structEncoded = structHead + titleEnc + artistEnc + fpEnc;
  // Array of 1 struct (dynamic struct → array tail contains offsets)
  // For an array of dynamic structs, the encoding is:
  //   length(32) + offset_to_struct0(32) + struct0_data
  const outerOffset = 32n; // function outer offset to array
  const arrayEncoded = encUint(1n) + encUint(32n) + structEncoded; // 1 element, struct at offset 32
  return "43deaf76" + ptr(outerOffset) + arrayEncoded;
}

// batchMint((uint256 artworkID, uint256 edition, address artist, address owner, string ipfsCID)[] mintParams_) = 12d907b9
// struct has 4 static + 1 dynamic (string) → struct is dynamic
function cd_batchMint() {
  const cid = "ipfs://QmTest";
  const cidEnc = encString(cid);
  const structHeadSize = 5 * 32; // artworkID(32)+edition(32)+artist(32)+owner(32)+cid_offset(32)
  const cidOffset = structHeadSize;
  const structHead = encUint(1001n) + encUint(1n) + encAddr(ADDR_SENDER) + encAddr(ADDR_RECEIVER) + encUint(BigInt(cidOffset));
  const structEncoded = structHead + cidEnc;
  const arrayEncoded = encUint(1n) + encUint(32n) + structEncoded;
  return "12d907b9" + ptr(32n) + arrayEncoded;
}

// authorizedTransfer((address from, address to, uint256 tokenID, uint256 expireTime, bytes32 r_, bytes32 s_, uint8 v_)[] transferParams_) = 9fbf39cd
// All struct fields are static (bytes32 is static) → struct is static (7*32=224 bytes)
function cd_authorizedTransfer(from, to, tokenID, expireTime) {
  const elem =
    encAddr(from) + encAddr(to) + encUint(tokenID) + encUint(expireTime) +
    ZERO_B32 + ZERO_B32 + V27;
  return "9fbf39cd" + ptr(32n) + encUint(1n) + elem;
}

// mintArtworkEdition(uint256 _artworkID, address _owner) = 05fd8493  (v3_3 only)
const cd_mintArtworkEdition = (artworkId, owner) =>
  "05fd8493" + encUint(artworkId) + encAddr(owner);

// updateArtworkCIDs(uint256[] _artworkIDs, string[] _artworkCIDs) = 59483325  (v3_3 only)
function cd_updateArtworkCIDs(ids, cids) {
  const idsEncoded = encUintArray(ids);
  const idsLen = 32 + ids.length * 32; // length word + elements
  const idsOffset = 64n;
  const cidsOffset = idsOffset + BigInt(idsLen);
  return "59483325" + encUint(idsOffset) + encUint(cidsOffset) + idsEncoded + encStringArray(cids);
}

// setSeriesNames(uint256[] seriesIds, string[] names) = fa35e4e2  (v4_4 only)
function cd_setSeriesNames(ids, names) {
  const idsEncoded = encUintArray(ids);
  const idsLen = 32 + ids.length * 32;
  const idsOffset = 64n;
  const namesOffset = idsOffset + BigInt(idsLen);
  return "fa35e4e2" + encUint(idsOffset) + encUint(namesOffset) + idsEncoded + encStringArray(names);
}

// setSeriesRenderer(uint256 seriesId, bytes blob) = 771ac303  (v4_4 only)
function cd_setSeriesRenderer(seriesId, blobHex) {
  return "771ac303" + encUint(seriesId) + ptr(64n) + encBytes(blobHex);
}

// setRendererTokenData(uint256[] tokenIds, (string imageURI, string textureURI, string tokenName)[] data) = 32f37c2e (v4_4 only)
// Each struct is dynamic (all strings), array of 1 struct
function cd_setRendererTokenData(tokenIds) {
  const imageURI = "ipfs://QmImg";
  const textURI = "ipfs://QmTex";
  const tokenName = "Test Token";
  const imageEnc = encString(imageURI);
  const texEnc = encString(textURI);
  const nameEnc = encString(tokenName);
  const structHeadSize = 3 * 32;
  const imageOffset = structHeadSize;
  const texOffset = imageOffset + imageEnc.length / 2;
  const nameOffset = texOffset + texEnc.length / 2;
  const structHead = encUint(BigInt(imageOffset)) + encUint(BigInt(texOffset)) + encUint(BigInt(nameOffset));
  const structEncoded = structHead + imageEnc + texEnc + nameEnc;
  const tokenIdsEncoded = encUintArray(tokenIds);
  const idsLen = 32 + tokenIds.length * 32;
  const idsOffset = 64n; // head: idsOffset(32)+dataOffset(32)
  const dataOffset = idsOffset + BigInt(idsLen);
  const dataArrayEncoded = encUint(1n) + encUint(32n) + structEncoded;
  return "32f37c2e" + encUint(idsOffset) + encUint(dataOffset) + tokenIdsEncoded + dataArrayEncoded;
}

// Auction: placeBid(uint256 auctionID_) = 9979ef45
const cd_placeBid = (id) => "9979ef45" + encUint(id);

// Auction: placeSignedBid(uint256,address,uint256,uint256,bytes32,bytes32,uint8) = e5de8f5d
const cd_placeSignedBid = (auctionId, bidder, amount, expiry) =>
  "e5de8f5d" +
  encUint(auctionId) + encAddr(bidder) + encUint(amount) + encUint(expiry) +
  ZERO_B32 + ZERO_B32 + V27;

// Auction: settleAuctionFund(uint256 auctionID_, address vaultAddr_) = 21fbf1e6
const cd_settleAuctionFund = (auctionId, vaultAddr) =>
  "21fbf1e6" + encUint(auctionId) + encAddr(vaultAddr);

// Auction: registerAuctions(...) = f92a6d58
// struct is all static (8 uint256 + 1 bool = 9 static fields)
function cd_registerAuctions(id, startAt, endAt, minPrice) {
  const elem =
    encUint(id) + encUint(startAt) + encUint(endAt) +
    encUint(3600n) + // extendDuration
    encUint(300n)  + // extendThreshold
    encUint(110n)  + // minIncreaseFactor (110 = 1.1x, but stored as raw)
    encUint(0n)    + // minIncreaseAmount
    encUint(minPrice) +
    encBool(false);  // isSettled
  return "f92a6d58" + ptr(32n) + encUint(1n) + elem;
}

// Auction: settleAuction(uint256,address,address,(uint256,uint256,uint256,address,uint256[],(address,uint256)[][],bool),bytes32,bytes32,uint8) = 0d33bcee
// saleData_ is dynamic (see buyArtworks)
function cd_settleAuction(auctionId, tokenAddr, vaultAddr, price, cost, expiryTime, destination, tokenIds) {
  // head: auctionId(32)+tokenAddr(32)+vaultAddr(32)+saleData_offset(32)+r_(32)+s_(32)+v_(32) = 7 slots = 224
  const tupleStaticSize = 7 * 32;
  const tokenIdsOffset = tupleStaticSize;
  const revShareOffset = tupleStaticSize + 32 + tokenIds.length * 32;
  const tupleHead =
    encUint(price) + encUint(cost) + encUint(expiryTime) +
    encAddr(destination) +
    encUint(BigInt(tokenIdsOffset)) + encUint(BigInt(revShareOffset)) +
    encBool(false); // payByVaultContract
  const tupleTail = encUintArray(tokenIds) + encUintArray([]);
  const tupleEncoded = tupleHead + tupleTail;
  const saleDataOffset = 4 * 32; // offset from param start: 3 static + saleData offset slot = 96
  // Actually: auctionId(32)+tokenAddr(32)+vaultAddr(32)+saleData_offset(32)+r_(32)+s_(32)+v_(32)
  // saleData offset is from the start of the *params* (after selector), so:
  // 7 static slots * 32 = 224 = 0xe0
  return (
    "0d33bcee" +
    encUint(auctionId) + encAddr(tokenAddr) + encAddr(vaultAddr) +
    encUint(7n * 32n) + // saleData_ offset from params start = 224
    ZERO_B32 + ZERO_B32 + V27 +
    tupleEncoded
  );
}

// Vault: withdrawFund(uint256 weiAmount) = 0cee1725
const cd_withdrawFund = (amount) => "0cee1725" + encUint(amount);

// Vault: payForSale(bytes32,bytes32,uint8,(uint256,uint256,uint256,address,uint256[],(address,uint256)[][],bool)) = 2eeee163
// saleData_ is 4th param (dynamic), same structure as buyArtworks tuple
function cd_payForSale(price, cost, expiryTime, destination, tokenIds) {
  const tupleStaticSize = 7 * 32;
  const tokenIdsOffset = tupleStaticSize;
  const revShareOffset = tupleStaticSize + 32 + tokenIds.length * 32;
  const tupleHead =
    encUint(price) + encUint(cost) + encUint(expiryTime) +
    encAddr(destination) +
    encUint(BigInt(tokenIdsOffset)) + encUint(BigInt(revShareOffset)) +
    encBool(false);
  const tupleTail = encUintArray(tokenIds) + encUintArray([]);
  const tupleEncoded = tupleHead + tupleTail;
  return (
    "2eeee163" +
    ZERO_B32 + ZERO_B32 + V27 +
    encUint(4n * 32n) + // saleData_ offset = 128
    tupleEncoded
  );
}

// Vault V2: payForSaleV2(bytes32,bytes32,uint8,(uint256,uint256,uint256,address,uint256,uint256,uint16,(address,uint256)[],bool)) = cdb1f663
function cd_payForSaleV2(price, cost, expiryTime, destination, nonce, seriesID, quantity) {
  const tupleStaticSize = 9 * 32;
  const revShareOffset = tupleStaticSize;
  const tupleHead =
    encUint(price) + encUint(cost) + encUint(expiryTime) +
    encAddr(destination) +
    encUint(nonce) + encUint(seriesID) + encUint(BigInt(quantity)) +
    encUint(BigInt(revShareOffset)) +
    encBool(false);
  const tupleTail = encUintArray([]); // empty revenueShares
  const tupleEncoded = tupleHead + tupleTail;
  return (
    "cdb1f663" +
    ZERO_B32 + ZERO_B32 + V27 +
    encUint(4n * 32n) +
    tupleEncoded
  );
}

// Airdrop: safeTransferFrom ERC-1155 = f242432a
function cd_safeTransferFrom1155(from, to, id, amount) {
  // head: from(32)+to(32)+id(32)+amount(32)+data_offset(32) = 5*32=160=0xa0
  return (
    "f242432a" +
    encAddr(from) + encAddr(to) + encUint(id) + encUint(amount) +
    encUint(5n * 32n) + // data offset = 160
    encUint(0n)         // bytes length = 0
  );
}

// Airdrop: safeBatchTransferFrom = 2eb2c2d6
function cd_safeBatchTransferFrom(from, to, ids, amounts) {
  // head: from(32)+to(32)+ids_offset(32)+amounts_offset(32)+data_offset(32) = 160
  const idsLen = 32 + ids.length * 32;
  const amtsLen = 32 + amounts.length * 32;
  const idsOffset = 5 * 32; // 160
  const amtsOffset = idsOffset + idsLen;
  const dataOffset = amtsOffset + amtsLen;
  return (
    "2eb2c2d6" +
    encAddr(from) + encAddr(to) +
    encUint(BigInt(idsOffset)) + encUint(BigInt(amtsOffset)) + encUint(BigInt(dataOffset)) +
    encUintArray(ids) + encUintArray(amounts) +
    encUint(0n) // empty bytes
  );
}

// Airdrop: burn(uint256 tokenID_, uint256 amount_) = b390c0ab
const cd_burn = (tokenId, amount) => "b390c0ab" + encUint(tokenId) + encUint(amount);

// Airdrop: mint(uint256 tokenID_, uint256 amount_) = 1b2ef1ca
const cd_mint = (tokenId, amount) => "1b2ef1ca" + encUint(tokenId) + encUint(amount);

// Airdrop: burnRemaining(uint256 tokenID_) = 96d67082
const cd_burnRemaining = (tokenId) => "96d67082" + encUint(tokenId);

// Airdrop: airdrop(uint256 tokenID_, address[] to_) = bdf7a8e6
function cd_airdrop(tokenId, recipients) {
  return "bdf7a8e6" + encUint(tokenId) + ptr(64n) + encAddrArray(recipients);
}

// Airdrop: end() = efbe1c1c
const cd_end = () => "efbe1c1c";

// Airdrop: setURI(string uri_) = 02fe5305
function cd_setURI(uri) {
  return "02fe5305" + ptr(32n) + encString(uri);
}

// Airdrop: setContractURI(string contractURI_) = 938e3d7b
function cd_setContractURI(uri) {
  return "938e3d7b" + ptr(32n) + encString(uri);
}

// ---------------------------------------------------------------------------
// Expected output helpers
// ---------------------------------------------------------------------------
const OWNER = "Feral File";
const ETH = (wei) => {
  // Format wei as ETH with no unnecessary trailing zeros
  const e = BigInt(wei);
  const base = 10n ** 18n;
  const whole = e / base;
  const frac = e % base;
  if (frac === 0n) return `${whole} ETH`;
  let fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
  return `${whole}.${fracStr} ETH`;
};

// Address display: if in addressNames use the name, else checksummed hex
// (We control addressNames so these are deterministic)
const addrDisplay = {
  [ADDR_SENDER.toLowerCase()]:   "Sender",
  [ADDR_RECEIVER.toLowerCase()]: "Receiver",
  [ADDR_OPERATOR.toLowerCase()]: "Test Operator",
  [ADDR_VAULT.toLowerCase()]:    "0x455464F0d369dAC13002e81e9fAB857f6aD21795",
  [ADDR_VAULTV2.toLowerCase()]:  "0xcBFaf4BDE69C9b37835761E5228f9fe9E25b452f",
};

function nftDisplay(collectionName, tokenId) {
  return `${collectionName} #${tokenId}`;
}

// ---------------------------------------------------------------------------
// File-writing helper
// ---------------------------------------------------------------------------
const OUT_DIR = path.join(__dirname, "../../registry/feral-file/testsv2");

function writeTestFile(filename, obj) {
  const p = path.join(OUT_DIR, filename);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  console.log("wrote", filename, `(${obj.tests.length} tests)`);
}

// ===========================================================================
// DESCRIPTOR: calldata-feralfile-airdrop-v1-0
// ===========================================================================
(function genAirdrop() {
  const to = ADDR_AIRDROP;
  const col = "Feral File Airdrop V1";
  const dp = {
    addressNames: {
      [ADDR_SENDER.toLowerCase()]:   "Sender",
      [ADDR_RECEIVER.toLowerCase()]: "Receiver",
      [ADDR_OPERATOR.toLowerCase()]: "Test Operator",
    },
    nftCollectionNames: { [to.toLowerCase()]: col },
  };

  writeTestFile("calldata-feralfile-airdrop-v1-0.tests.json", {
    $schema: "../../../specs/erc7730-tests-v2.schema.json",
    descriptor: "../calldata-feralfile-airdrop-v1-0.json",
    dataProvider: dp,
    tests: [
      {
        description: "Transfer airdrop token - ERC1155 safeTransferFrom",
        rawTx: buildTx({ to, data: cd_safeTransferFrom1155(ADDR_SENDER, ADDR_RECEIVER, TOKEN_ID, 1n) }),
        expected: {
          intent: "Transfer airdrop token",
          owner: OWNER,
          fields: [
            { label: "From", value: "Sender" },
            { label: "To", value: "Receiver" },
            { label: "Artwork", value: nftDisplay(col, TOKEN_ID) },
            { label: "Amount", value: "1" },
          ],
          interpolatedIntent: `Transfer 1 of token ${nftDisplay(col, TOKEN_ID)} to Receiver`,
        },
      },
      {
        description: "Batch transfer airdrop tokens - safeBatchTransferFrom",
        rawTx: buildTx({ to, data: cd_safeBatchTransferFrom(ADDR_SENDER, ADDR_RECEIVER, [TOKEN_ID], [1n]) }),
        expected: {
          intent: "Batch transfer airdrop tokens",
          owner: OWNER,
          fields: [
            { label: "From", value: "Sender" },
            { label: "To", value: "Receiver" },
            { label: "Artworks", value: nftDisplay(col, TOKEN_ID) },
            { label: "Amounts", value: "1" },
          ],
        },
      },
      {
        description: "Set operator approval - grant all",
        rawTx: buildTx({ to, data: cd_setApprovalForAll(ADDR_OPERATOR, true) }),
        expected: {
          intent: "Set operator approval",
          owner: OWNER,
          fields: [
            { label: "Operator", value: "Test Operator" },
            { label: "Approved", value: "true" },
          ],
        },
      },
      {
        description: "Set operator approval - revoke all",
        rawTx: buildTx({ to, data: cd_setApprovalForAll(ADDR_OPERATOR, false) }),
        expected: {
          intent: "Set operator approval",
          owner: OWNER,
          fields: [
            { label: "Operator", value: "Test Operator" },
            { label: "Approved", value: "false" },
          ],
        },
      },
      {
        description: "Burn airdrop token",
        rawTx: buildTx({ to, data: cd_burn(TOKEN_ID, 3n) }),
        expected: {
          intent: "Burn airdrop token",
          owner: OWNER,
          fields: [
            { label: "Artwork", value: nftDisplay(col, TOKEN_ID) },
            { label: "Amount", value: "3" },
          ],
          interpolatedIntent: `Destroy 3 of token ${nftDisplay(col, TOKEN_ID)}`,
        },
      },
      {
        description: "Mint airdrop tokens to contract",
        rawTx: buildTx({ to, data: cd_mint(TOKEN_ID2, 100n) }),
        expected: {
          intent: "Mint airdrop tokens to contract",
          owner: OWNER,
          fields: [
            { label: "Artwork", value: nftDisplay(col, TOKEN_ID2) },
            { label: "Amount", value: "100" },
          ],
        },
      },
      {
        description: "Airdrop tokens to recipients",
        rawTx: buildTx({ to, data: cd_airdrop(TOKEN_ID, [ADDR_RECEIVER]) }),
        expected: {
          intent: "Airdrop tokens to recipients",
          owner: OWNER,
          fields: [
            { label: "Artwork", value: nftDisplay(col, TOKEN_ID) },
            { label: "Recipients", value: ADDR_RECEIVER },
          ],
        },
      },
      {
        description: "End airdrop",
        rawTx: buildTx({ to, data: cd_end() }),
        expected: {
          intent: "End airdrop",
          owner: OWNER,
          fields: [],
        },
      },
      {
        description: "Set token URI",
        rawTx: buildTx({ to, data: cd_setURI("ipfs://QmTestMetadata") }),
        expected: {
          intent: "Set token URI",
          owner: OWNER,
          fields: [{ label: "URI", value: "ipfs://QmTestMetadata" }],
        },
      },
      {
        description: "Set contract URI",
        rawTx: buildTx({ to, data: cd_setContractURI("https://feralfile.com/api/contract") }),
        expected: {
          intent: "Set contract URI",
          owner: OWNER,
          fields: [{ label: "Contract URI", value: "https://feralfile.com/api/contract" }],
        },
      },
      {
        description: "Burn remaining airdrop supply",
        rawTx: buildTx({ to, data: cd_burnRemaining(TOKEN_ID) }),
        expected: {
          intent: "Burn remaining airdrop supply",
          owner: OWNER,
          fields: [{ label: "Artwork", value: nftDisplay(col, TOKEN_ID) }],
        },
      },
    ],
  });
})();

// ===========================================================================
// DESCRIPTOR: calldata-feralfile-vault-0
// ===========================================================================
(function genVault0() {
  const to = ADDR_VAULT;
  const col = "Feral File Vault";
  const dp = {
    addressNames: {
      [ADDR_RECEIVER.toLowerCase()]: "Receiver",
    },
    nftCollectionNames: { [to.toLowerCase()]: col },
  };

  writeTestFile("calldata-feralfile-vault-0.tests.json", {
    $schema: "../../../specs/erc7730-tests-v2.schema.json",
    descriptor: "../calldata-feralfile-vault-0.json",
    dataProvider: dp,
    tests: [
      {
        description: "Pay for artwork sale - payForSale",
        rawTx: buildTx({
          to,
          value: 500000000000000000n,
          data: cd_payForSale(
            500000000000000000n, // price 0.5 ETH
            50000000000000000n,  // cost 0.05 ETH
            1735689600n,         // expiryTime
            ADDR_RECEIVER,
            [TOKEN_ID],
          ),
        }),
        expected: {
          intent: "Pay for artwork sale",
          owner: OWNER,
          fields: [
            { label: "Price", value: "0.5 ETH" },
            { label: "Platform cost", value: "0.05 ETH" },
            { label: "Recipient", value: "Receiver" },
            { label: "Artworks", value: nftDisplay(col, TOKEN_ID) },
          ],
        },
      },
      {
        description: "Withdraw vault funds - 0.5 ETH",
        rawTx: buildTx({ to, data: cd_withdrawFund(500000000000000000n) }),
        expected: {
          intent: "Withdraw vault funds",
          owner: OWNER,
          fields: [{ label: "Amount", value: "0.5 ETH" }],
        },
      },
    ],
  });
})();

// ===========================================================================
// DESCRIPTOR: calldata-feralfile-vault-v2-0
// ===========================================================================
(function genVaultV2() {
  const to = ADDR_VAULTV2;
  const dp = {
    addressNames: {
      [ADDR_RECEIVER.toLowerCase()]: "Receiver",
    },
  };

  writeTestFile("calldata-feralfile-vault-v2-0.tests.json", {
    $schema: "../../../specs/erc7730-tests-v2.schema.json",
    descriptor: "../calldata-feralfile-vault-v2-0.json",
    dataProvider: dp,
    tests: [
      {
        description: "Pay for bulk artwork sale - payForSaleV2",
        rawTx: buildTx({
          to,
          value: 500000000000000000n,
          data: cd_payForSaleV2(
            500000000000000000n, // price
            50000000000000000n,  // cost
            1735689600n,         // expiryTime
            ADDR_RECEIVER,
            42n,                 // nonce
            7n,                  // seriesID
            5,                   // quantity
          ),
        }),
        expected: {
          intent: "Pay for bulk artwork sale",
          owner: OWNER,
          fields: [
            { label: "Price", value: "0.5 ETH" },
            { label: "Platform cost", value: "0.05 ETH" },
            { label: "Recipient", value: "Receiver" },
            { label: "Series ID", value: "7" },
            { label: "Quantity", value: "5" },
          ],
        },
      },
      {
        description: "Withdraw vault funds - 0.5 ETH",
        rawTx: buildTx({ to, data: cd_withdrawFund(500000000000000000n) }),
        expected: {
          intent: "Withdraw vault funds",
          owner: OWNER,
          fields: [{ label: "Amount", value: "0.5 ETH" }],
        },
      },
    ],
  });
})();

// ===========================================================================
// DESCRIPTOR: calldata-feralfile-english-auction-0
// ===========================================================================
(function genAuction() {
  const to = ADDR_AUCTION;
  const col = "Feral File Exhibition V4";
  const exhAddr = EXHIB.v4;
  const dp = {
    addressNames: {
      [ADDR_RECEIVER.toLowerCase()]:  "Receiver",
      [ADDR_VAULTV2.toLowerCase()]:   "Vault V2",
      [exhAddr.toLowerCase()]:        "Exhibition V4",
    },
    nftCollectionNames: { [exhAddr.toLowerCase()]: col },
  };

  writeTestFile("calldata-feralfile-english-auction-0.tests.json", {
    $schema: "../../../specs/erc7730-tests-v2.schema.json",
    descriptor: "../calldata-feralfile-english-auction-0.json",
    dataProvider: dp,
    tests: [
      {
        description: "Place bid on auction 42 - 0.1 ETH",
        rawTx: buildTx({ to, value: 100000000000000000n, data: cd_placeBid(42n) }),
        expected: {
          intent: "Place auction bid",
          owner: OWNER,
          fields: [
            { label: "Auction ID", value: "42" },
            { label: "Bid amount", value: "0.1 ETH" },
          ],
          interpolatedIntent: "Bid on auction 42",
        },
      },
      {
        description: "Place signed bid on auction 42 for Receiver - 0.5 ETH",
        rawTx: buildTx({
          to,
          data: cd_placeSignedBid(42n, ADDR_RECEIVER, 500000000000000000n, 1735689600n),
        }),
        expected: {
          intent: "Place signed auction bid",
          owner: OWNER,
          fields: [
            { label: "Auction ID", value: "42" },
            { label: "Bidder", value: "Receiver" },
            { label: "Bid amount", value: "0.5 ETH" },
            { label: "Signature expires", value: "Jan 1, 2025" },
          ],
          interpolatedIntent: "Bid 0.5 ETH on auction 42 for Receiver",
        },
      },
      {
        description: "Register auctions",
        rawTx: buildTx({
          to,
          data: cd_registerAuctions(1n, 1735689600n, 1735776000n, 100000000000000000n),
        }),
        expected: {
          intent: "Register auctions",
          owner: OWNER,
          fields: [
            { label: "Auction ID", value: "1" },
            { label: "Minimum price", value: "0.1 ETH" },
            { label: "Starts", value: "Jan 1, 2025" },
            { label: "Ends", value: "Jan 2, 2025" },
          ],
        },
      },
      {
        description: "Settle auction funds",
        rawTx: buildTx({ to, data: cd_settleAuctionFund(42n, ADDR_VAULTV2) }),
        expected: {
          intent: "Settle auction funds",
          owner: OWNER,
          fields: [
            { label: "Auction ID", value: "42" },
            { label: "Vault", value: "Vault V2" },
          ],
        },
      },
      {
        description: "Settle auction and deliver artworks",
        rawTx: buildTx({
          to,
          data: cd_settleAuction(42n, exhAddr, ADDR_VAULTV2, 500000000000000000n, 50000000000000000n, 1735689600n, ADDR_RECEIVER, [TOKEN_ID]),
        }),
        expected: {
          intent: "Settle auction and deliver artworks",
          owner: OWNER,
          fields: [
            { label: "Auction ID", value: "42" },
            { label: "Exhibition contract", value: "Exhibition V4" },
            { label: "Vault", value: "Vault V2" },
            { label: "Winner", value: "Receiver" },
            { label: "Sale price", value: "0.5 ETH" },
            { label: "Platform cost", value: "0.05 ETH" },
            { label: "Artworks", value: nftDisplay(col, TOKEN_ID) },
          ],
        },
      },
    ],
  });
})();

// ===========================================================================
// HELPERS for exhibition descriptors
// ===========================================================================

function buildExhibitionV2Tests(to, col, dp) {
  return [
    {
      description: "Transfer artwork - transferFrom",
      rawTx: buildTx({ to, data: cd_transferFrom(ADDR_SENDER, ADDR_RECEIVER, TOKEN_ID) }),
      expected: {
        intent: "Transfer artwork",
        owner: OWNER,
        fields: [
          { label: "From", value: "Sender" },
          { label: "To", value: "Receiver" },
          { label: "Artwork", value: nftDisplay(col, TOKEN_ID) },
        ],
        interpolatedIntent: `Transfer token ${nftDisplay(col, TOKEN_ID)} from Sender to Receiver`,
      },
    },
    {
      description: "Transfer artwork - safeTransferFrom",
      rawTx: buildTx({ to, data: cd_safeTransferFrom3(ADDR_SENDER, ADDR_RECEIVER, TOKEN_ID) }),
      expected: {
        intent: "Transfer artwork",
        owner: OWNER,
        fields: [
          { label: "From", value: "Sender" },
          { label: "To", value: "Receiver" },
          { label: "Artwork", value: nftDisplay(col, TOKEN_ID) },
        ],
        interpolatedIntent: `Safely transfer token ${nftDisplay(col, TOKEN_ID)} to Receiver`,
      },
    },
    {
      description: "Transfer artwork - safeTransferFrom with data",
      rawTx: buildTx({ to, data: cd_safeTransferFrom4(ADDR_SENDER, ADDR_RECEIVER, TOKEN_ID) }),
      expected: {
        intent: "Transfer artwork",
        owner: OWNER,
        fields: [
          { label: "From", value: "Sender" },
          { label: "To", value: "Receiver" },
          { label: "Artwork", value: nftDisplay(col, TOKEN_ID) },
        ],
        interpolatedIntent: `Safely transfer token ${nftDisplay(col, TOKEN_ID)} to Receiver`,
      },
    },
    {
      description: "Approve artwork transfer",
      rawTx: buildTx({ to, data: cd_approve(ADDR_OPERATOR, TOKEN_ID) }),
      expected: {
        intent: "Approve artwork transfer",
        owner: OWNER,
        fields: [
          { label: "Operator", value: "Test Operator" },
          { label: "Artwork", value: nftDisplay(col, TOKEN_ID) },
        ],
        interpolatedIntent: `Allow Test Operator to transfer token ${nftDisplay(col, TOKEN_ID)}`,
      },
    },
    {
      description: "Set operator approval - grant all",
      rawTx: buildTx({ to, data: cd_setApprovalForAll(ADDR_OPERATOR, true) }),
      expected: {
        intent: "Set operator approval",
        owner: OWNER,
        fields: [
          { label: "Operator", value: "Test Operator" },
          { label: "Approved", value: "true" },
        ],
        interpolatedIntent: "true all tokens for Test Operator",
      },
    },
    {
      description: "Create artwork",
      rawTx: buildTx({ to, data: cd_createArtworks() }),
      expected: {
        intent: "Create artwork",
        owner: OWNER,
        fields: [
          { label: "Title", value: "Test Artwork" },
          { label: "Artist", value: "Test Artist" },
          { label: "Fingerprint", value: "fp_test_001" },
          { label: "Edition size", value: "10" },
        ],
      },
    },
    {
      description: "Set royalty payout address",
      rawTx: buildTx({ to, data: cd_setRoyaltyPayoutAddress(ADDR_RECEIVER) }),
      expected: {
        intent: "Set royalty payout address",
        owner: OWNER,
        fields: [{ label: "Payout address", value: "Receiver" }],
      },
    },
    {
      description: "Set token base URI",
      rawTx: buildTx({ to, data: cd_setTokenBaseURI("https://feralfile.com/token/") }),
      expected: {
        intent: "Set token base URI",
        owner: OWNER,
        fields: [{ label: "Base URI", value: "https://feralfile.com/token/" }],
      },
    },
    {
      description: "Update edition IPFS CID",
      rawTx: buildTx({ to, data: cd_updateArtworkEditionIPFSCid(TOKEN_ID, "QmTestCID") }),
      expected: {
        intent: "Update edition IPFS CID",
        owner: OWNER,
        fields: [
          { label: "Artwork", value: nftDisplay(col, TOKEN_ID) },
          { label: "IPFS CID", value: "QmTestCID" },
        ],
      },
    },
  ];
}

// V3-specific additions on top of V2 base
function buildV3Additions(to, col) {
  return [
    {
      description: "Burn artwork editions",
      rawTx: buildTx({ to, data: cd_burnEditions([TOKEN_ID]) }),
      expected: {
        intent: "Burn artwork editions",
        owner: OWNER,
        fields: [{ label: "Edition IDs", value: `${TOKEN_ID}` }],
      },
    },
    {
      description: "Authorize artwork transfer",
      rawTx: buildTx({
        to,
        data: cd_authorizedTransfer(ADDR_SENDER, ADDR_RECEIVER, TOKEN_ID, 1735689600n),
      }),
      expected: {
        intent: "Authorize artwork transfer",
        owner: OWNER,
        fields: [
          { label: "From", value: "Sender" },
          { label: "To", value: "Receiver" },
          { label: "Artwork", value: nftDisplay(col, TOKEN_ID) },
          { label: "Expires", value: "Jan 1, 2025" },
        ],
      },
    },
    {
      description: "Batch mint editions",
      rawTx: buildTx({ to, data: cd_batchMint() }),
      expected: {
        intent: "Batch mint editions",
        owner: OWNER,
        fields: [
          { label: "Artwork ID", value: "1001" },
          { label: "Edition", value: "1" },
          { label: "Artist", value: "Sender" },
          { label: "Owner", value: "Receiver" },
          { label: "IPFS CID", value: "ipfs://QmTest" },
        ],
      },
    },
  ];
}

// V4-specific: burnArtworks + buyArtworks + lifecycle + mint + admin
function buildV4Tests(to, col, dp, opts = {}) {
  const base = [
    {
      description: "Transfer artwork - transferFrom",
      rawTx: buildTx({ to, data: cd_transferFrom(ADDR_SENDER, ADDR_RECEIVER, TOKEN_ID) }),
      expected: {
        intent: "Transfer artwork",
        owner: OWNER,
        fields: [
          { label: "From", value: "Sender" },
          { label: "To", value: "Receiver" },
          { label: "Artwork", value: nftDisplay(col, TOKEN_ID) },
        ],
        interpolatedIntent: `Transfer token ${nftDisplay(col, TOKEN_ID)} from Sender to Receiver`,
      },
    },
    {
      description: "Transfer artwork - safeTransferFrom",
      rawTx: buildTx({ to, data: cd_safeTransferFrom3(ADDR_SENDER, ADDR_RECEIVER, TOKEN_ID) }),
      expected: {
        intent: "Transfer artwork",
        owner: OWNER,
        fields: [
          { label: "From", value: "Sender" },
          { label: "To", value: "Receiver" },
          { label: "Artwork", value: nftDisplay(col, TOKEN_ID) },
        ],
        interpolatedIntent: `Safely transfer token ${nftDisplay(col, TOKEN_ID)} to Receiver`,
      },
    },
    {
      description: "Transfer artwork - safeTransferFrom with data",
      rawTx: buildTx({ to, data: cd_safeTransferFrom4(ADDR_SENDER, ADDR_RECEIVER, TOKEN_ID) }),
      expected: {
        intent: "Transfer artwork",
        owner: OWNER,
        fields: [
          { label: "From", value: "Sender" },
          { label: "To", value: "Receiver" },
          { label: "Artwork", value: nftDisplay(col, TOKEN_ID) },
        ],
        interpolatedIntent: `Safely transfer token ${nftDisplay(col, TOKEN_ID)} to Receiver`,
      },
    },
    {
      description: "Approve artwork transfer",
      rawTx: buildTx({ to, data: cd_approve(ADDR_OPERATOR, TOKEN_ID) }),
      expected: {
        intent: "Approve artwork transfer",
        owner: OWNER,
        fields: [
          { label: "Operator", value: "Test Operator" },
          { label: "Artwork", value: nftDisplay(col, TOKEN_ID) },
        ],
        interpolatedIntent: `Allow Test Operator to transfer token ${nftDisplay(col, TOKEN_ID)}`,
      },
    },
    {
      description: "Set operator approval - grant all",
      rawTx: buildTx({ to, data: cd_setApprovalForAll(ADDR_OPERATOR, true) }),
      expected: {
        intent: "Set operator approval",
        owner: OWNER,
        fields: [
          { label: "Operator", value: "Test Operator" },
          { label: "Approved", value: "true" },
        ],
        interpolatedIntent: "true all tokens for Test Operator",
      },
    },
    {
      description: "Burn artworks",
      rawTx: buildTx({ to, data: cd_burnArtworks([TOKEN_ID]) }),
      expected: {
        intent: "Burn artworks",
        owner: OWNER,
        fields: [{ label: "Artworks", value: nftDisplay(col, TOKEN_ID) }],
        interpolatedIntent: "Permanently destroy selected artworks",
      },
    },
  ];

  const buyFn = opts.buyBulk
    ? {
        description: "Purchase artworks in bulk - buyBulkArtworks",
        rawTx: buildTx({
          to,
          value: 500000000000000000n,
          data: cd_buyBulkArtworks(
            500000000000000000n, 50000000000000000n, 1735689600n,
            ADDR_RECEIVER, 42n, 7n, 5, false,
          ),
        }),
        expected: {
          intent: "Purchase artworks in bulk",
          owner: OWNER,
          fields: [
            { label: "Price", value: "0.5 ETH" },
            { label: "Platform cost", value: "0.05 ETH" },
            { label: "Recipient", value: "Receiver" },
            { label: "Series ID", value: "7" },
            { label: "Quantity", value: "5" },
            { label: "Pay via vault", value: "false" },
          ],
        },
      }
    : {
        description: "Purchase artworks - buyArtworks",
        rawTx: buildTx({
          to,
          value: 500000000000000000n,
          data: cd_buyArtworks(
            500000000000000000n, 50000000000000000n, 1735689600n,
            ADDR_RECEIVER, [TOKEN_ID], false,
          ),
        }),
        expected: {
          intent: "Purchase artworks",
          owner: OWNER,
          fields: [
            { label: "Price", value: "0.5 ETH" },
            { label: "Platform cost", value: "0.05 ETH" },
            { label: "Recipient", value: "Receiver" },
            { label: "Artworks", value: nftDisplay(col, TOKEN_ID) },
            { label: "Offer expires", value: "Jan 1, 2025" },
            { label: "Pay via vault", value: "false" },
          ],
          interpolatedIntent: "Buy artworks for Receiver",
        },
      };

  return [
    ...base,
    buyFn,
    {
      description: "Start artwork sale",
      rawTx: buildTx({ to, data: cd_startSale() }),
      expected: { intent: "Start artwork sale", owner: OWNER, fields: [] },
    },
    {
      description: "Pause artwork sale",
      rawTx: buildTx({ to, data: cd_pauseSale() }),
      expected: { intent: "Pause artwork sale", owner: OWNER, fields: [] },
    },
    {
      description: "Resume artwork sale",
      rawTx: buildTx({ to, data: cd_resumeSale() }),
      expected: { intent: "Resume artwork sale", owner: OWNER, fields: [] },
    },
    {
      description: "Stop sale and burn unsold artworks",
      rawTx: buildTx({ to, data: cd_stopSaleAndBurn() }),
      expected: { intent: "Stop sale and burn unsold artworks", owner: OWNER, fields: [] },
    },
    {
      description: "Stop sale and return unsold artworks",
      rawTx: buildTx({ to, data: cd_stopSaleAndTransfer([7n], [ADDR_RECEIVER]) }),
      expected: {
        intent: "Stop sale and return unsold artworks",
        owner: OWNER,
        fields: [
          { label: "Series IDs", value: "7" },
          { label: "Recipients", value: ADDR_RECEIVER },
        ],
      },
    },
    {
      description: "Mint artworks",
      rawTx: buildTx({
        to,
        data: cd_mintArtworks([{ seriesId: 7n, tokenId: TOKEN_ID, owner: ADDR_RECEIVER }]),
      }),
      expected: {
        intent: "Mint artworks",
        owner: OWNER,
        fields: [
          { label: "Series ID", value: "7" },
          { label: "Artwork", value: nftDisplay(col, TOKEN_ID) },
          { label: "Owner", value: "Receiver" },
        ],
      },
    },
    {
      description: "Set vault contract",
      rawTx: buildTx({ to, data: cd_setVault(ADDR_VAULT) }),
      expected: {
        intent: "Set vault contract",
        owner: OWNER,
        fields: [{ label: "Vault", value: ADDR_VAULT }],
      },
    },
    {
      description: "Set cost receiver",
      rawTx: buildTx({ to, data: cd_setCostReceiver(ADDR_RECEIVER) }),
      expected: {
        intent: "Set cost receiver",
        owner: OWNER,
        fields: [{ label: "Cost receiver", value: "Receiver" }],
      },
    },
    {
      description: "Set token base URI",
      rawTx: buildTx({ to, data: cd_setTokenBaseURI("https://feralfile.com/token/") }),
      expected: {
        intent: "Set token base URI",
        owner: OWNER,
        fields: [{ label: "Base URI", value: "https://feralfile.com/token/" }],
      },
    },
    ...(opts.hasAdvance ? [
      {
        description: "Set advance payment settings",
        rawTx: buildTx({ to, data: cd_setAdvanceSetting([ADDR_RECEIVER], [100000000000000000n]) }),
        expected: {
          intent: "Set advance payment settings",
          owner: OWNER,
          fields: [
            { label: "Addresses", value: ADDR_RECEIVER },
            { label: "Advance amounts", value: "0.1 ETH" },
          ],
        },
      },
      {
        description: "Replace advance payment addresses",
        rawTx: buildTx({ to, data: cd_replaceAdvanceAddresses([ADDR_SENDER], [ADDR_RECEIVER]) }),
        expected: {
          intent: "Replace advance payment addresses",
          owner: OWNER,
          fields: [
            { label: "Old addresses", value: ADDR_SENDER },
            { label: "New addresses", value: ADDR_RECEIVER },
          ],
        },
      },
    ] : []),
    ...(opts.hasVaultV2 ? [{
      description: "Set vault V2 contract",
      rawTx: buildTx({ to, data: cd_setVaultV2(ADDR_VAULTV2) }),
      expected: {
        intent: "Set vault V2 contract",
        owner: OWNER,
        fields: [{ label: "Vault", value: ADDR_VAULTV2 }],
      },
    }] : []),
    ...(opts.hasMerge ? [{
      description: "Merge artworks",
      rawTx: buildTx({ to, data: cd_mergeArtworks([TOKEN_ID, TOKEN_ID2]) }),
      expected: {
        intent: "Merge artworks",
        owner: OWNER,
        fields: [{ label: "Artworks", value: `${nftDisplay(col, TOKEN_ID)}, ${nftDisplay(col, TOKEN_ID2)}` }],
      },
    }] : []),
    ...(opts.hasRendererData ? [
      {
        description: "Set series names",
        rawTx: buildTx({ to, data: cd_setSeriesNames([7n], ["Test Series"]) }),
        expected: {
          intent: "Set series names",
          owner: OWNER,
          fields: [
            { label: "Series IDs", value: "7" },
            { label: "Names", value: "Test Series" },
          ],
        },
      },
      {
        description: "Set series renderer",
        rawTx: buildTx({ to, data: cd_setSeriesRenderer(7n, "") }),
        expected: {
          intent: "Set series renderer",
          owner: OWNER,
          fields: [
            { label: "Series ID", value: "7" },
            { label: "Renderer data", value: "0x" },
          ],
        },
      },
      {
        description: "Set renderer token data",
        rawTx: buildTx({ to, data: cd_setRendererTokenData([TOKEN_ID]) }),
        expected: {
          intent: "Set renderer token data",
          owner: OWNER,
          fields: [
            { label: "Token IDs", value: `${TOKEN_ID}` },
            { label: "Image URI", value: "ipfs://QmImg" },
            { label: "Texture URI", value: "ipfs://QmTex" },
            { label: "Token name", value: "Test Token" },
          ],
        },
      },
    ] : []),
  ];
}

// ===========================================================================
// DESCRIPTOR: exhibition-v2
// ===========================================================================
(function genExhibV2() {
  const to = EXHIB.v2;
  const col = "Feral File Exhibition V2";
  const dp = { ...baseDataProvider(to, col) };
  writeTestFile("calldata-feralfile-exhibition-v2-0.tests.json", {
    $schema: "../../../specs/erc7730-tests-v2.schema.json",
    descriptor: "../calldata-feralfile-exhibition-v2-0.json",
    dataProvider: dp,
    tests: buildExhibitionV2Tests(to, col, dp),
  });
})();

// ===========================================================================
// DESCRIPTORS: exhibition-v3, v3_2, v3_3
// ===========================================================================
function genV3(version, to, col, file, hasExtra3_3) {
  const dp = { ...baseDataProvider(to, col) };
  const tests = [
    ...buildExhibitionV2Tests(to, col, dp).filter(t =>
      // v3 replaces createArtwork with createArtworks (shared), burnEditions different
      !t.description.startsWith("Create artwork") // createArtworks already in V3 additions
    ),
    ...buildV3Additions(to, col),
    ...(hasExtra3_3 ? [
      {
        description: "Mint artwork edition",
        rawTx: buildTx({ to, data: cd_mintArtworkEdition(1001n, ADDR_RECEIVER) }),
        expected: {
          intent: "Mint artwork edition",
          owner: OWNER,
          fields: [
            { label: "Artwork ID", value: "1001" },
            { label: "Owner", value: "Receiver" },
          ],
        },
      },
      {
        description: "Update artwork CIDs",
        rawTx: buildTx({ to, data: cd_updateArtworkCIDs([TOKEN_ID], ["QmTestCID"]) }),
        expected: {
          intent: "Update artwork CIDs",
          owner: OWNER,
          fields: [
            { label: "Artwork IDs", value: `${TOKEN_ID}` },
            { label: "IPFS CIDs", value: "QmTestCID" },
          ],
        },
      },
    ] : []),
  ];
  writeTestFile(file, {
    $schema: "../../../specs/erc7730-tests-v2.schema.json",
    descriptor: `../${file.replace(".tests.json", ".json")}`,
    dataProvider: dp,
    tests,
  });
}

genV3("v3",   EXHIB.v3,   "Feral File Exhibition V3",   "calldata-feralfile-exhibition-v3-0.tests.json",   false);
genV3("v3_2", EXHIB.v3_2, "Feral File Exhibition V3.2", "calldata-feralfile-exhibition-v3_2-0.tests.json", false);
genV3("v3_3", EXHIB.v3_3, "Feral File Exhibition V3.3", "calldata-feralfile-exhibition-v3_3-0.tests.json", true);

// ===========================================================================
// DESCRIPTORS: exhibition-v4, v4_1, v4_2, v4_3, v4_4, v4_5
// ===========================================================================
function genV4(to, col, file, opts = {}) {
  const dp = {
    ...baseDataProvider(to, col),
    addressNames: {
      ...baseDataProvider(to, col).addressNames,
      [ADDR_VAULT.toLowerCase()]: ADDR_VAULT,
      [ADDR_VAULTV2.toLowerCase()]: ADDR_VAULTV2,
    },
  };
  writeTestFile(file, {
    $schema: "../../../specs/erc7730-tests-v2.schema.json",
    descriptor: `../${file.replace(".tests.json", ".json")}`,
    dataProvider: dp,
    tests: buildV4Tests(to, col, dp, opts),
  });
}

genV4(EXHIB.v4,   "Feral File Exhibition V4",   "calldata-feralfile-exhibition-v4-0.tests.json",   {});
genV4(EXHIB.v4_1, "Feral File Exhibition V4.1", "calldata-feralfile-exhibition-v4_1-0.tests.json", { hasAdvance: true });
genV4(EXHIB.v4_2, "Feral File Exhibition V4.2", "calldata-feralfile-exhibition-v4_2-0.tests.json", { hasAdvance: true, hasVaultV2: true, buyBulk: true });
genV4(EXHIB.v4_3, "Feral File Exhibition V4.3", "calldata-feralfile-exhibition-v4_3-0.tests.json", { hasAdvance: true, hasMerge: true });
genV4(EXHIB.v4_4, "Feral File Exhibition V4.4", "calldata-feralfile-exhibition-v4_4-0.tests.json", { hasAdvance: true, hasRendererData: true });
genV4(EXHIB.v4_5, "Feral File Exhibition V4.5", "calldata-feralfile-exhibition-v4_5-0.tests.json", { hasAdvance: true });

console.log("\nDone. All test files written to registry/feral-file/testsv2/");
