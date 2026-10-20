# Triage of pull requests with red CI

`triage-red-prs.js` goes through the open pull requests that have a failed check on their last commit or a pending change request, and does one of three things for each of them.

| Situation | Action |
| --- | --- |
| A test runner (Sourcify SDK or Rust SDK) is red, whatever the other one says | Comment on the pull request and tag the maintainers, so they compare the two runners before the author rewrites the descriptor: a red runner can be a runner bug. The comment is posted once per head commit. |
| A check other than the two runners is red and the author did nothing for more than N weeks | Close the pull request with a comment that lists the red checks and says how to reopen. |
| A reviewer requested changes and the author did nothing for more than N weeks | Close the pull request with a comment. This rule needs no red check. |

N is 4 weeks by default. A pull request that matches both close rules gets one comment with both reasons. A pull request that matches a close rule and the runner rule is closed, not commented.

## What counts

- **Red**: a check with conclusion `FAILURE`, `TIMED_OUT`, `STARTUP_FAILURE` or `ERROR`. A cancelled run is not red. When the same check ran twice on the head commit, a passed run supersedes a failed one.
- **Ignored checks**: the optional AI Review workflow, the label bots (`PR Labels` and its predecessors), the `Descriptor Tests Queued` note and its predecessor `Clear Signing Tests Started`, and the `Notify fork PR` job of the old test workflow.
- **Author activity**: commits by the author, and comments, reviews and review replies by the author. Comments of bots and the merge commits a maintainer pushes with Update branch do not count, so a bulk Update branch does not reset the clock.
- **Drafts** are treated like any other pull request.

## Usage

The script needs the GitHub CLI (`gh`) logged in with write access to the repository. By default it is a dry run and only prints its plan.

```bash
# Print the plan
node tools/scripts/triage-red-prs.js

# Print the plan with the full text of every comment
node tools/scripts/triage-red-prs.js --verbose

# Post the comments and close the pull requests
node tools/scripts/triage-red-prs.js --apply

# Other options
node tools/scripts/triage-red-prs.js --weeks 6 --maintainers kuzdogan,manuelwedler --pr 2994 --pr 3005
```

Run the dry run first and read the plan: the script closes pull requests. It posts sequentially with a pause between calls, because GitHub applies a secondary rate limit to bursts of comments.

## Comments

Every comment ends with a link to this script, so a contributor knows where it came from. The runner comment carries a hidden marker with the head commit, which is how the script knows it already reported that commit.
