#!/bin/bash
# Filter APDU logs to show only exchange lines, excluding keep-alives
#
# Usage: ./filter-apdu.sh <apdu-log-file> [output-file]
#
# This script filters raw APDU logs to extract only the send (=>) and receive (<=)
# lines, excluding keep-alive APDUs (b001000000).

set -e

INPUT_FILE="$1"
OUTPUT_FILE="$2"

if [ -z "$INPUT_FILE" ]; then
    echo "Usage: $0 <apdu-log-file> [output-file]"
    echo ""
    echo "Filters APDU log to show only exchange lines (=> and <=)"
    echo "Excludes keep-alive APDUs (b001000000)"
    echo ""
    echo "Examples:"
    echo "  $0 output/logs/apdu-log-20260206-131651.txt                    # Print to stdout"
    echo "  $0 output/logs/apdu-log-20260206-131651.txt filtered-apdu.txt  # Save to file"
    exit 1
fi

if [ ! -f "$INPUT_FILE" ]; then
    echo "Error: File not found: $INPUT_FILE"
    exit 1
fi

# Filter logic:
# 1. Find lines containing [SpeculosTransport] [exchange]
# 2. Extract only the => and <= lines
# 3. Exclude keep-alive APDUs (b001000000) and their responses
filter_apdus() {
    grep -E "(\[SpeculosTransport\].*\[exchange\]|^.*=> |^.*<= )" "$INPUT_FILE" | \
    grep -E "(=> |<= )" | \
    grep -vi "b001000000" | \
    grep -vi "0108457468657265756d" | \
    sed 's/^.*=> /=> /' | \
    sed 's/^.*<= /<= /'
}

if [ -n "$OUTPUT_FILE" ]; then
    filter_apdus > "$OUTPUT_FILE"
    echo "Filtered APDU log saved to: $OUTPUT_FILE"
    echo ""
    echo "Summary:"
    echo "  Total exchanges: $(wc -l < "$OUTPUT_FILE")"
    echo "  Sent (=>): $(grep -c "^=> " "$OUTPUT_FILE" || echo 0)"
    echo "  Received (<=): $(grep -c "^<= " "$OUTPUT_FILE" || echo 0)"
else
    filter_apdus
fi
