import { describe, expect, it } from "vitest";
import {
  calldataDigest,
  cidToContenthash,
  contenthashToCid,
  safeBatchChecksum,
  serializeJsonObject,
} from "../lib.mjs";

describe("CID ↔ contenthash", () => {
  // The CID currently pinned for erc7730.eth (real data from a build).
  const CID_STR = "bafybeihhz5x4dppncx2zok64nusxmxqqbzln5fvuq67iueue2536wwp6tq";
  const CONTENTHASH =
    "0xe30101701220e7cf6fc1bded15f5972bdc6d25765e100e56de96b487be8a1284d777eb59fe9c";

  it("encodes a CIDv1 with the IPFS multicodec prefix 0xe301", () => {
    expect(cidToContenthash(CID_STR)).toBe(CONTENTHASH);
  });

  it("decodes back to the original CID string", () => {
    expect(contenthashToCid(CONTENTHASH)).toBe(CID_STR);
  });

  it("returns null for the empty contenthash", () => {
    expect(contenthashToCid("0x")).toBeNull();
    expect(contenthashToCid("")).toBeNull();
  });

  it("returns null for non-IPFS contenthashes (e.g. Swarm 0xe40101)", () => {
    expect(contenthashToCid("0xe401017012aabbccdd")).toBeNull();
  });

  it("returns null for malformed bytes (decode failure)", () => {
    // Right magic prefix but garbage payload.
    expect(contenthashToCid("0xe301ff")).toBeNull();
  });
});

describe("calldataDigest (ERC-8213)", () => {
  it("hashes empty calldata as keccak256 of 32 zero bytes", () => {
    // keccak256(uint256(0)) — the length-prefix word is all zero, there's no payload.
    expect(calldataDigest("0x")).toBe(
      "0x290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563",
    );
  });

  it("is stable: digest of the setContenthash calldata we emit", () => {
    // Real calldata from a build of this repo. If this changes, either
    // the encoding broke or the inputs changed — both warrant scrutiny.
    const calldata =
      "0x304e6adea3d4b673d1c6ada4e292e34eb6fbdd5bd941dcba0c120dda4970d5bb424051b800000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000026e30101701220e7cf6fc1bded15f5972bdc6d25765e100e56de96b487be8a1284d777eb59fe9c0000000000000000000000000000000000000000000000000000";
    expect(calldataDigest(calldata)).toBe(
      "0x98fac460a45d4aad341295e920dda5a4fbe04ed31156965cb97e72953fbe2b0d",
    );
  });

  it("differs from a single-byte change in the calldata", () => {
    const a = "0x1234";
    const b = "0x1235";
    expect(calldataDigest(a)).not.toBe(calldataDigest(b));
  });
});

describe("serializeJsonObject (Safe checksum preimage)", () => {
  it("sorts object keys before serialization", () => {
    const a = serializeJsonObject({ b: 1, a: 2 });
    const b = serializeJsonObject({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it("emits keys first then values (matches safe-react-apps shape)", () => {
    expect(serializeJsonObject({ a: 1, b: 2 })).toBe(`{["a","b"]1,2,}`);
  });

  it("converts undefined to null", () => {
    expect(serializeJsonObject({ a: undefined })).toBe(`{["a"]null,}`);
  });

  it("walks into arrays", () => {
    expect(serializeJsonObject([1, "x", { k: 2 }])).toBe(`[1,"x",{["k"]2,}]`);
  });
});

describe("safeBatchChecksum", () => {
  it("strips meta.name to null before hashing", () => {
    const a = {
      version: "1.0",
      meta: { name: "A", description: "x", checksum: "" },
      transactions: [],
    };
    const b = {
      version: "1.0",
      meta: { name: "B (different)", description: "x", checksum: "" },
      transactions: [],
    };
    // Different name should not affect checksum — that's the whole point of nulling it.
    expect(safeBatchChecksum(a)).toBe(safeBatchChecksum(b));
  });

  it("reacts to a change in the transactions array", () => {
    const base = {
      version: "1.0",
      meta: { name: "", description: "", checksum: "" },
      transactions: [{ to: "0xa", value: "0", data: "0x" }],
    };
    const modified = {
      ...base,
      transactions: [{ to: "0xa", value: "1", data: "0x" }],
    };
    expect(safeBatchChecksum(base)).not.toBe(safeBatchChecksum(modified));
  });

  it("reacts to a change in meta.description (description is not stripped)", () => {
    const a = {
      version: "1.0",
      meta: { name: "", description: "x", checksum: "" },
      transactions: [],
    };
    const b = {
      version: "1.0",
      meta: { name: "", description: "y", checksum: "" },
      transactions: [],
    };
    expect(safeBatchChecksum(a)).not.toBe(safeBatchChecksum(b));
  });
});
