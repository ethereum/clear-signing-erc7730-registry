# EIP-712 Test Example Generation Prompt

Generate a realistic EIP-712 typed data example for testing a clear signing descriptor.

## Output Format

Output ONLY a single valid JSON object. No markdown, no explanations, no code fences. Just the raw JSON.

The JSON must have this structure:

```
{
  "types": {
    "EIP712Domain": [ ... ],
    "<PrimaryType>": [ ... ]
  },
  "primaryType": "<PrimaryType>",
  "domain": {
    "name": "...",
    "version": "...",
    "chainId": ...,
    "verifyingContract": "0x..."
  },
  "message": { ... }
}
```

## Requirements

- Use realistic values: real token addresses, reasonable amounts, plausible deadlines
- All address fields should be valid checksummed Ethereum addresses (not zero addresses)
- Numeric amounts should be realistic for the token (e.g., 18-decimal wei values for ETH-like tokens)
- Timestamps/deadlines should be reasonable future Unix timestamps
- The `types` object must include `EIP712Domain` and all referenced struct types
- The `domain` must match the contract deployment if provided
- The `message` must contain all fields defined in the primary type
