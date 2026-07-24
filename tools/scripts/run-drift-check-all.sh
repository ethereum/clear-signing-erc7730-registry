#!/usr/bin/env bash
# Run tools/scripts/check-contract-functions.js over every calldata
# descriptor in registry/ and ercs/ and emit a markdown summary.
#
# Per-file exits 0 (clean), 2 (mismatches), or 1 (errors); this driver
# never aborts on a single failure — it aggregates and reports.
#
# Output goes to stdout, and (when set) to $GITHUB_STEP_SUMMARY.
#
# Environment:
#   ETHERSCAN_API_KEY (required by the checker)
#
# Usage:
#   ETHERSCAN_API_KEY=... tools/scripts/run-drift-check-all.sh
#   ETHERSCAN_API_KEY=... tools/scripts/run-drift-check-all.sh --all-chains
set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

EXTRA_ARGS=("$@")

CHECKER="tools/scripts/check-contract-functions.js"
if [[ ! -f "$CHECKER" ]]; then
  echo "Checker not found at $CHECKER" >&2
  exit 1
fi

shopt -s globstar nullglob
FILES=(registry/**/calldata-*.json ercs/calldata-*.json)

# Drop anything under registry/**/tests/ (matches the rest of CI).
FILTERED=()
for f in "${FILES[@]}"; do
  case "$f" in
    registry/*/tests/*) ;;
    *) FILTERED+=("$f") ;;
  esac
done

TOTAL=${#FILTERED[@]}
CLEAN=0
MISMATCH=0
ERROR=0
MISMATCH_LIST=()
ERROR_LIST=()

echo "Running drift check across $TOTAL calldata descriptor(s)..." >&2

for file in "${FILTERED[@]}"; do
  OUTPUT=$(node "$CHECKER" "$file" "${EXTRA_ARGS[@]}" 2>&1)
  STATUS=$?
  case $STATUS in
    0)
      CLEAN=$((CLEAN + 1))
      ;;
    2)
      MISMATCH=$((MISMATCH + 1))
      MISMATCH_LIST+=("$file")
      echo "::group::MISMATCH $file"
      printf '%s\n' "$OUTPUT"
      echo "::endgroup::"
      ;;
    *)
      ERROR=$((ERROR + 1))
      ERROR_LIST+=("$file")
      echo "::group::ERROR ($STATUS) $file"
      printf '%s\n' "$OUTPUT"
      echo "::endgroup::"
      ;;
  esac
done

# Markdown summary.
SUMMARY=$(cat <<EOF
# Registry selector drift report

- ✅ Clean: **$CLEAN**
- ❌ Mismatches: **$MISMATCH**
- ⚠️ Errors: **$ERROR**
- Total checked: **$TOTAL**

EOF
)

if (( MISMATCH > 0 )); then
  SUMMARY+=$'\n## Descriptors with on-chain selector mismatches\n\n'
  for f in "${MISMATCH_LIST[@]}"; do
    SUMMARY+="- \`$f\`"$'\n'
  done
fi

if (( ERROR > 0 )); then
  SUMMARY+=$'\n## Descriptors that errored during validation\n\n'
  for f in "${ERROR_LIST[@]}"; do
    SUMMARY+="- \`$f\`"$'\n'
  done
fi

printf '%s' "$SUMMARY"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '%s' "$SUMMARY" >> "$GITHUB_STEP_SUMMARY"
fi

# Exit non-zero if anything failed, so the workflow can decide to open an issue.
if (( MISMATCH > 0 || ERROR > 0 )); then
  exit 2
fi
exit 0
