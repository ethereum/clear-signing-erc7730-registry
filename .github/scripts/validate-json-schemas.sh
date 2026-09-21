#!/usr/bin/env bash
# Validate registry JSON files against the JSON schema each one declares.
#
# Usage: .github/scripts/validate-json-schemas.sh <file>...
#
# Each descriptor names its schema in its "$schema" key, as a path relative
# to the descriptor. Test files carry no "$schema" key, so their folder picks
# the schema. Auditor attestations under sigs/ have no schema yet and are
# skipped.
#
# A "$schema" value that is a URL, or that does not resolve to a file under
# specs/, is an error. CI used to fall back to the default schema for those,
# which hid a wrong or stale reference behind a passing check.
#
# Files are grouped by schema, and check-jsonschema runs once per schema, so
# validating the whole registry costs a handful of Python start-ups instead
# of one per file.

set -euo pipefail

DEFAULT_SCHEMA="specs/erc7730-v2.schema.json"
TESTS_V1_SCHEMA="specs/erc7730-tests.schema.json"
TESTS_V2_SCHEMA="specs/erc7730-tests-v2.schema.json"

declare -A FILES_BY_SCHEMA
FAILED=0

for file in "$@"; do
  [ -n "$file" ] || continue

  if [[ "$file" == */sigs/* ]]; then
    echo "Skipping $file (auditor attestation, no schema yet)"
    continue
  fi

  # Folder-based dispatch for test files takes precedence, because test
  # files do not carry a "$schema" key.
  if [[ "$file" =~ /testsv2/.*\.tests\.json$ ]]; then
    schema="$TESTS_V2_SCHEMA"
  elif [[ "$file" =~ /tests/.*\.tests\.json$ ]]; then
    schema="$TESTS_V1_SCHEMA"
  else
    ref=$(jq -r '."$schema" // ""' "$file" 2>/dev/null || echo "")

    if [ -z "$ref" ]; then
      schema="$DEFAULT_SCHEMA"
    elif [[ "$ref" =~ ^https?:// ]]; then
      echo "::error file=${file},line=1::The \"\$schema\" key is a URL (${ref}). Point it at the schema file in this repository by a relative path, for example \"../../specs/erc7730-v2.schema.json\", so that the file is validated against the schema it names."
      FAILED=1
      continue
    else
      resolved=$(python3 -c 'import os, sys; print(os.path.relpath(os.path.normpath(os.path.join(os.path.dirname(sys.argv[1]), sys.argv[2]))))' "$file" "$ref")
      if [[ "$resolved" != specs/* ]] || [ ! -f "$resolved" ]; then
        echo "::error file=${file},line=1::The \"\$schema\" key (${ref}) does not resolve to a schema file under specs/. Use a relative path such as \"../../specs/erc7730-v2.schema.json\"."
        FAILED=1
        continue
      fi
      schema="$resolved"
    fi
  fi

  FILES_BY_SCHEMA["$schema"]+="$file"$'\n'
done

for schema in "${!FILES_BY_SCHEMA[@]}"; do
  mapfile -t files < <(printf '%s' "${FILES_BY_SCHEMA[$schema]}")
  echo "::group::Validating ${#files[@]} file(s) against $schema"
  if ! check-jsonschema --schemafile "$schema" "${files[@]}"; then
    FAILED=1
  fi
  echo "::endgroup::"
done

if [ "$FAILED" -ne 0 ]; then
  echo "::error::One or more files failed JSON schema validation"
  exit 1
fi
