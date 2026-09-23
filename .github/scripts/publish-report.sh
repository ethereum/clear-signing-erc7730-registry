#!/usr/bin/env bash
# Publishes one test report bundle to the test-reports branch.
#
# The branch holds one file per run, pr/<number>/<run id>.json, and one index
# per pull request, pr/<number>/index.json. The branch has no history worth
# keeping and no code, so this script never rebases: when a push loses a race
# against the run of another pull request, it fetches the new tip, applies the
# files again on top of it, and pushes again. The files of a run are only
# added or replaced, so a retry is safe.
#
# Environment:
#   REPO_URL     the repository, with credentials for a push
#   BUNDLE       path of the bundle to publish
#   PR_NUMBER    the pull request
#   RUN_ID       the workflow run; names the file
#   TESTED_SHA   the commit that was tested; named in the commit message
#   BRANCH       the branch, default test-reports
#   WORKDIR      an empty or absent directory to clone into, default reports
#   SCRIPTS_DIR  where report-index.js lives, default beside this script
#   ATTEMPTS     push attempts, default 3
#
# Writes report_path=pr/<number>/<run id>.json to GITHUB_OUTPUT when set.

set -euo pipefail

: "${REPO_URL:?}" "${BUNDLE:?}" "${PR_NUMBER:?}" "${RUN_ID:?}" "${TESTED_SHA:?}"
BRANCH="${BRANCH:-test-reports}"
WORKDIR="${WORKDIR:-reports}"
ATTEMPTS="${ATTEMPTS:-3}"
SCRIPTS_DIR="${SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
BUNDLE="$(cd "$(dirname "$BUNDLE")" && pwd)/$(basename "$BUNDLE")"
SCRIPTS_DIR="$(cd "$SCRIPTS_DIR" && pwd)"

case "$PR_NUMBER$RUN_ID" in *[!0-9]*) echo "PR_NUMBER and RUN_ID must be numbers" >&2; exit 1 ;; esac

export GIT_AUTHOR_NAME="github-actions[bot]"
export GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

REPORT_DIR="pr/$PR_NUMBER"
REPORT_PATH="$REPORT_DIR/$RUN_ID.json"
SHA7="${TESTED_SHA:0:7}"

mkdir -p "$WORKDIR"
cd "$WORKDIR"
if [ ! -d .git ]; then
  git init -q
  git remote add origin "$REPO_URL"
fi

write_readme() {
  cat > README.md <<'EOF'
# Test reports

This branch is written by the Test Results workflow. Do not edit it by hand, and do not base work on it: it has no shared history with `master`, and it can be recreated from scratch at any time.

Each run of the Tests workflow on a pull request adds one bundle, and updates the index of that pull request:

```
pr/<pull request number>/<run id>.json   the bundle of one run
pr/<pull request number>/index.json      the runs of the pull request, newest first
```

The bundle format is documented in `.github/test-runner-docs/bundle.md` on `master`. The test report viewer reads the files from `raw.githubusercontent.com`.
EOF
}

# Copies the bundle in and updates the index, then commits.
apply() {
  mkdir -p "$REPORT_DIR"
  cp "$BUNDLE" "$REPORT_PATH"
  node "$SCRIPTS_DIR/report-index.js" --bundle "$REPORT_PATH" --index "$REPORT_DIR/index.json" --run-id "$RUN_ID"
  if [ ! -f README.md ]; then write_readme; fi
  git add -A
  git commit -q -m "report: PR $PR_NUMBER run $RUN_ID ($SHA7)"
}

for attempt in $(seq 1 "$ATTEMPTS"); do
  if git fetch -q --depth=1 origin "$BRANCH" 2>/dev/null; then
    # The branch exists: start from its tip, dropping any earlier attempt.
    git checkout -q -B "$BRANCH" FETCH_HEAD
  elif git rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null 2>&1; then
    # An earlier attempt created the branch locally and the push failed
    # although the branch is still absent upstream. Reuse it.
    git checkout -q "$BRANCH"
  else
    # The branch does not exist yet: create it without a parent.
    git checkout -q --orphan "$BRANCH"
    git rm -rq --cached . 2>/dev/null || true
  fi

  apply

  if git push -q origin "$BRANCH"; then
    echo "published $REPORT_PATH to $BRANCH (attempt $attempt)"
    if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "report_path=$REPORT_PATH" >> "$GITHUB_OUTPUT"; fi
    exit 0
  fi
  echo "push to $BRANCH failed (attempt $attempt of $ATTEMPTS)" >&2
  sleep $((attempt * 5))
done

echo "could not publish $REPORT_PATH after $ATTEMPTS attempts" >&2
exit 1
