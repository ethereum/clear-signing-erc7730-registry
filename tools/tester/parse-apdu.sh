#!/bin/bash
# Parse and format APDU exchanges from log files
#
# Usage: ./parse-apdu.sh <apdu-log-file> [output-file]
#
# This script parses raw APDU logs from the clear-signing-tester and formats
# them into human-readable request/response pairs with decoded command names,
# parameters, and status codes based on the Ethereum app documentation.
#
# Reference: https://github.com/LedgerHQ/app-ethereum/blob/develop/doc/ethapp.adoc

set -e

INPUT_FILE="$1"
OUTPUT_FILE="$2"

if [ -z "$INPUT_FILE" ]; then
    echo "Usage: $0 <apdu-log-file> [output-file]"
    echo ""
    echo "Parses APDU log and formats exchanges as request/response pairs"
    echo "Excludes keep-alive APDUs (b001000000)"
    echo ""
    echo "Examples:"
    echo "  $0 output/logs/apdu-log-20260206-131651.txt                    # Print to stdout"
    echo "  $0 output/logs/apdu-log-20260206-131651.txt parsed-apdu.txt    # Save to file"
    exit 1
fi

if [ ! -f "$INPUT_FILE" ]; then
    echo "Error: File not found: $INPUT_FILE"
    exit 1
fi

# Python script for parsing and formatting APDUs
python3 - "$INPUT_FILE" "$OUTPUT_FILE" << 'PYTHON_SCRIPT'
import sys
import re

input_file = sys.argv[1]
output_file = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None

# Ethereum App APDU Commands (CLA=E0) from official doc
# https://github.com/LedgerHQ/app-ethereum/blob/develop/doc/ethapp.adoc
APDU_COMMANDS = {
    "e002": "GET_ETH_PUBLIC_ADDRESS",
    "e004": "SIGN_ETH_TRANSACTION",
    "e006": "GET_APP_CONFIGURATION",
    "e008": "SIGN_ETH_PERSONAL_MESSAGE",
    "e00a": "PROVIDE_ERC20_TOKEN_INFO",
    "e00c": "SIGN_ETH_EIP712",
    "e00e": "GET_ETH2_PUBLIC_KEY",
    "e010": "SET_ETH2_WITHDRAWAL_INDEX",
    "e012": "SET_EXTERNAL_PLUGIN",
    "e014": "PROVIDE_NFT_INFORMATION",
    "e016": "SET_PLUGIN",
    "e018": "PERFORM_PRIVACY_OPERATION",
    "e01a": "EIP712_STRUCT_DEF",
    "e01c": "EIP712_STRUCT_IMPL",
    "e01e": "EIP712_FILTERING",
    "e020": "GET_CHALLENGE",
    "e022": "PROVIDE_DOMAIN_NAME",
    "e024": "PROVIDE_ENUM_VALUE",
    "e026": "TRANSACTION_INFO",
    "e028": "TRANSACTION_FIELD_DESCRIPTION",
    "e02a": "PROVIDE_PROXY_INFO",
    "e030": "PROVIDE_NETWORK_CONFIGURATION",
    "e032": "PROVIDE_TX_SIMULATION",
    "e034": "SIGN_EIP7702_AUTHORIZATION",
    "e036": "PROVIDE_SAFE_ACCOUNT",
    "e038": "PROVIDE_GATED_SIGNING",
    "b001": "KEEP_ALIVE",
}

# P2 values for EIP712_STRUCT_DEF (0x1A)
EIP712_STRUCT_DEF_P2 = {
    "00": "struct_name",
    "ff": "struct_field",
}

# P2 values for EIP712_STRUCT_IMPL (0x1C)
EIP712_STRUCT_IMPL_P2 = {
    "00": "root_struct",
    "0f": "array",
    "ff": "struct_field",
}

# P2 values for EIP712_FILTERING (0x1E)
EIP712_FILTERING_P2 = {
    "00": "activation",
    "01": "discarded_path",
    "0f": "message_info",
    "f4": "calldata_spender",
    "f5": "calldata_amount",
    "f6": "calldata_selector",
    "f7": "calldata_chain_id",
    "f8": "calldata_callee",
    "f9": "calldata_value",
    "fa": "calldata_info",
    "fb": "trusted_name",
    "fc": "datetime",
    "fd": "amount_join_token",
    "fe": "amount_join_value",
    "ff": "raw_field",
}

# Type descriptions for EIP712 struct fields
EIP712_TYPES = {
    0: "custom",
    1: "int",
    2: "uint",
    3: "address",
    4: "bool",
    5: "string",
    6: "bytes_fixed",
    7: "bytes_dynamic",
}

def hex_to_ascii(hex_str):
    """Convert hex string to ASCII if printable"""
    try:
        bytes_data = bytes.fromhex(hex_str)
        text = bytes_data.decode('ascii')
        if all(32 <= ord(c) < 127 for c in text):
            return text
    except:
        pass
    return None

def parse_bip32_path(data, offset=0):
    """Parse BIP32 derivation path from hex data"""
    try:
        num_derivations = int(data[offset:offset+2], 16)
        path_parts = []
        pos = offset + 2
        for _ in range(num_derivations):
            index = int(data[pos:pos+8], 16)
            if index >= 0x80000000:
                path_parts.append(f"{index - 0x80000000}'")
            else:
                path_parts.append(str(index))
            pos += 8
        return f"m/{'/'.join(path_parts)}", pos
    except:
        return None, offset

def get_apdu_info(apdu_hex):
    """Parse APDU and return command info with details"""
    apdu = apdu_hex.lower().replace(" ", "")
    if len(apdu) < 8:
        return "INVALID", ""
    
    cla = apdu[0:2]
    ins = apdu[2:4]
    p1 = apdu[4:6]
    p2 = apdu[6:8]
    lc = apdu[8:10] if len(apdu) > 8 else "00"
    data = apdu[10:] if len(apdu) > 10 else ""
    
    cmd_key = cla + ins
    cmd_name = APDU_COMMANDS.get(cmd_key, f"UNKNOWN_{cmd_key.upper()}")
    
    details = []
    details.append(f"P1={p1} P2={p2}")
    
    # Parse specific commands
    if cmd_key == "e002":  # GET_ETH_PUBLIC_ADDRESS
        p1_desc = "display_confirm" if p1 == "01" else "return_only"
        p2_desc = "with_chaincode" if p2 == "01" else "no_chaincode"
        details = [f"{p1_desc}, {p2_desc}"]
        if data:
            path, _ = parse_bip32_path(data)
            if path:
                details.append(f"path={path}")
    
    elif cmd_key == "e006":  # GET_APP_CONFIGURATION
        details = ["query_config"]
    
    elif cmd_key == "e00c":  # SIGN_ETH_EIP712
        p2_desc = "v0_hashes" if p2 == "00" else "full_impl"
        details = [f"{p2_desc}"]
        if data:
            path, pos = parse_bip32_path(data)
            if path:
                details.append(f"path={path}")
    
    elif cmd_key == "e01a":  # EIP712_STRUCT_DEF
        p2_desc = EIP712_STRUCT_DEF_P2.get(p2, f"unknown_{p2}")
        if p2 == "00" and data:  # struct name
            name = hex_to_ascii(data)
            if name:
                details = [f"DEFINE_STRUCT: \"{name}\""]
            else:
                details = [f"struct_name: {data}"]
        elif p2 == "ff" and data:  # struct field
            # Parse field definition
            type_desc = int(data[0:2], 16) if len(data) >= 2 else 0
            is_array = (type_desc >> 7) & 1
            has_size = (type_desc >> 6) & 1
            type_id = type_desc & 0x0F
            type_name = EIP712_TYPES.get(type_id, f"type_{type_id}")
            
            pos = 2
            field_info = [f"type={type_name}"]
            if is_array:
                field_info.append("array")
            
            # Try to extract field name at the end
            if len(data) > 4:
                # Field name is at the end, prefixed by its length
                try:
                    # Scan backwards to find the field name
                    name_len = int(data[-2-2:-2], 16) if len(data) > 4 else 0
                    if name_len > 0 and name_len < 64:
                        name_hex = data[-(name_len*2):]
                        name = hex_to_ascii(name_hex)
                        if name:
                            field_info.append(f"field=\"{name}\"")
                except:
                    pass
            
            details = [f"FIELD: {', '.join(field_info)}"]
        else:
            details = [p2_desc]
    
    elif cmd_key == "e01c":  # EIP712_STRUCT_IMPL
        p1_desc = "partial" if p1 == "01" else "complete"
        p2_desc = EIP712_STRUCT_IMPL_P2.get(p2, f"unknown_{p2}")
        if p2 == "00" and data:  # root struct name
            name = hex_to_ascii(data)
            if name:
                details = [f"ROOT_STRUCT: \"{name}\""]
            else:
                details = [f"root_struct: {data}"]
        elif p2 == "0f" and data:  # array size
            size = int(data[0:2], 16) if len(data) >= 2 else 0
            details = [f"ARRAY: size={size}"]
        elif p2 == "ff" and data:  # field value
            # Value length is 2 bytes BE, then value
            if len(data) >= 4:
                val_len = int(data[0:4], 16)
                value = data[4:4+val_len*2]
                # Try to interpret value
                if val_len <= 32:
                    ascii_val = hex_to_ascii(value)
                    if ascii_val:
                        details = [f"VALUE: \"{ascii_val}\" ({val_len} bytes)"]
                    elif val_len == 20:  # address
                        details = [f"VALUE: 0x{value} (address)"]
                    elif val_len <= 8:  # likely integer
                        int_val = int(value, 16) if value else 0
                        details = [f"VALUE: {int_val} (0x{value})"]
                    else:
                        details = [f"VALUE: 0x{value[:40]}{'...' if len(value) > 40 else ''} ({val_len} bytes)"]
                else:
                    details = [f"VALUE: {val_len} bytes"]
            else:
                details = [f"{p1_desc}, {p2_desc}"]
        else:
            details = [f"{p1_desc}, {p2_desc}"]
    
    elif cmd_key == "e01e":  # EIP712_FILTERING
        p1_desc = "discarded" if p1 == "01" else "standard"
        p2_desc = EIP712_FILTERING_P2.get(p2, f"unknown_{p2}")
        if p2 == "00":
            details = ["ACTIVATE_FILTERING"]
        elif p2 == "0f" and data:  # message_info
            if len(data) >= 2:
                name_len = int(data[0:2], 16)
                name_hex = data[2:2+name_len*2]
                name = hex_to_ascii(name_hex)
                if name:
                    details = [f"MESSAGE_INFO: \"{name}\""]
                else:
                    details = [f"message_info: {p1_desc}"]
            else:
                details = [f"message_info: {p1_desc}"]
        elif p2 in ["fb", "fc", "fe", "ff"] and data:  # filters with display name
            if len(data) >= 2:
                name_len = int(data[0:2], 16)
                name_hex = data[2:2+name_len*2]
                name = hex_to_ascii(name_hex)
                filter_type = {
                    "fb": "TRUSTED_NAME",
                    "fc": "DATETIME", 
                    "fe": "AMOUNT_JOIN_VALUE",
                    "ff": "RAW_FIELD",
                }.get(p2, p2_desc.upper())
                if name:
                    details = [f"{filter_type}: \"{name}\""]
                else:
                    details = [f"{p2_desc}: {p1_desc}"]
            else:
                details = [f"{p2_desc}: {p1_desc}"]
        elif p2 == "fd" and data:  # amount_join_token
            if len(data) >= 2:
                token_idx = int(data[0:2], 16)
                details = [f"AMOUNT_JOIN_TOKEN: index={token_idx}"]
            else:
                details = [f"{p2_desc}: {p1_desc}"]
        else:
            details = [f"{p2_desc}: {p1_desc}"]
    
    elif cmd_key == "e032":  # PROVIDE_TX_SIMULATION
        p1_desc = "opt_in" if p1 == "01" else "payload"
        details = [p1_desc]
    
    return cmd_name, " | ".join(details)

def parse_status_word(sw):
    """Parse the status word (last 4 hex chars of response)"""
    sw = sw.lower()
    status_codes = {
        "9000": "OK",
        "6001": "MODE_CHECK_FAIL",
        "6501": "TX_TYPE_NOT_SUPPORTED",
        "6700": "INCORRECT_LENGTH",
        "6982": "SECURITY_NOT_SATISFIED",
        "6983": "WRONG_DATA_LENGTH",
        "6984": "PLUGIN_NOT_INSTALLED",
        "6985": "CONDITION_NOT_SATISFIED",
        "6a00": "ERROR_NO_INFO",
        "6a80": "INVALID_DATA",
        "6a84": "INSUFFICIENT_MEMORY",
        "6a88": "DATA_NOT_FOUND",
        "6b00": "INCORRECT_P1_P2",
        "6d00": "INS_NOT_SUPPORTED",
        "6e00": "CLA_NOT_SUPPORTED",
        "6f00": "TECHNICAL_PROBLEM",
    }
    # Check for 6Fxx technical problems
    if sw.startswith("6f"):
        return f"TECHNICAL_PROBLEM_{sw[2:].upper()}"
    if sw.startswith("68"):
        return f"INTERNAL_ERROR_{sw[2:].upper()}"
    return status_codes.get(sw, f"SW_{sw.upper()}")

def format_response(resp_hex):
    """Format response with status word parsing"""
    resp = resp_hex.strip().lower().replace(" ", "")
    if len(resp) >= 4:
        sw = resp[-4:]
        data = resp[:-4] if len(resp) > 4 else ""
        status = parse_status_word(sw)
        if data:
            return f"SW:{status} data:{len(data)//2}B"
        else:
            return f"SW:{status}"
    return resp

# Read and filter log file
exchanges = []
current_request = None

with open(input_file, 'r') as f:
    for line in f:
        # Skip keep-alive APDUs
        if 'b001000000' in line.lower() or '0108457468657265756d' in line.lower():
            continue
            
        # Look for send lines (=>)
        send_match = re.search(r'=>\s*([0-9a-fA-F]+)', line)
        if send_match:
            current_request = send_match.group(1)
            continue
            
        # Look for receive lines (<=)
        recv_match = re.search(r'<=\s*([0-9a-fA-F]+)', line)
        if recv_match and current_request:
            response = recv_match.group(1)
            exchanges.append((current_request, response))
            current_request = None

# Format output
output_lines = []
output_lines.append("=" * 100)
output_lines.append("APDU Exchange Log (filtered) - Ethereum App")
output_lines.append("Reference: https://github.com/LedgerHQ/app-ethereum/blob/develop/doc/ethapp.adoc")
output_lines.append("=" * 100)
output_lines.append("")

for i, (req, resp) in enumerate(exchanges, 1):
    cmd_name, cmd_details = get_apdu_info(req)
    resp_info = format_response(resp)
    
    # Truncate raw APDU if too long
    req_display = req if len(req) <= 60 else req[:60] + "..."
    
    output_lines.append(f"[{i:03d}] {cmd_name}")
    output_lines.append(f"      => {req_display}")
    output_lines.append(f"         {cmd_details}")
    output_lines.append(f"      <= {resp_info}")
    output_lines.append("")

output_lines.append("=" * 100)
output_lines.append(f"Total exchanges: {len(exchanges)}")
output_lines.append("=" * 100)

output_text = "\n".join(output_lines)

if output_file:
    with open(output_file, 'w') as f:
        f.write(output_text)
    print(f"Parsed APDU log saved to: {output_file}")
    print(f"Total exchanges: {len(exchanges)}")
else:
    print(output_text)
PYTHON_SCRIPT
