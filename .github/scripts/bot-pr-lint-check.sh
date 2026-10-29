#!/usr/bin/env bash
# The bot workflows open pull requests with GITHUB_TOKEN. GitHub starts no
# pull_request_target run for such a pull request, so the required check of
# descriptor-lint.yml never reports and the pull request cannot merge. When
# the changes of the bot affect no descriptor, the linter has nothing to lint,
# and the bot workflow reports the check itself. The merge queue still runs
# the linter on merge_group.
#
# Usage:
#   bot-pr-lint-check.sh affected      Compares the uncommitted changes with
#                                      HEAD and writes affected=true|false to
#                                      $GITHUB_OUTPUT. A change of layout
#                                      only does not count.
#   bot-pr-lint-check.sh report <sha>  Reports the linter check as passed on
#                                      commit <sha>. Needs GH_TOKEN with the
#                                      checks: write permission.
set -euo pipefail

# Must be the same as the job name in descriptor-lint.yml, which is a
# required check of master.
CHECK_NAME="Descriptors pass the ERC-7730 linter"

case "${1:-}" in
  affected)
    BASE_TREE=$(mktemp -d)
    git archive HEAD registry ercs | tar -x -C "$BASE_TREE"
    CHANGED=$({ git diff --name-only HEAD; git ls-files --others --exclude-standard; } | tr '\n' ' ')
    RESULT=$(CHANGED_FILES="$CHANGED" BASE_ROOT="$BASE_TREE" \
      node .github/scripts/list-affected-descriptors.js)
    AFFECTED=$(echo "$RESULT" | jq -r '.has_affected')
    if [ "$AFFECTED" = "true" ]; then
      echo "$RESULT" | jq -r '.affected_descriptors[]'
      echo "::warning::The changes affect descriptors, so the linter must run on the pull request. Push to its branch to start the linter."
    fi
    echo "affected=${AFFECTED}" >> "$GITHUB_OUTPUT"
    ;;
  report)
    gh api "repos/${GITHUB_REPOSITORY}/check-runs" \
      -f name="$CHECK_NAME" \
      -f head_sha="$2" \
      -f status=completed \
      -f conclusion=success \
      -f "output[title]=No descriptor to lint" \
      -f "output[summary]=The bot workflow ${GITHUB_WORKFLOW} found that its changes affect no descriptor: they change the layout of descriptors only, or files outside them. The merge queue runs the linter." \
      --silent
    ;;
  *)
    echo "usage: $0 affected | report <sha>" >&2
    exit 2
    ;;
esac
