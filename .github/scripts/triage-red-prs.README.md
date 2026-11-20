# Triage of pull requests with red CI

`triage-red-prs.js` goes through the open pull requests that have a failed check on their last commit or a pending change request, and does one thing for each of them.

| Situation | Action |
| --- | --- |
| One test runner (Sourcify SDK or Rust SDK) is red and the other one is green or did not run | Comment on the pull request and tag the maintainers, so they compare the two runners before the author rewrites the descriptor: a disagreement is often a runner bug. The comment is posted once per head commit, and the pull request is not closed while the disagreement is open, whatever the other checks say. |
| Both test runners are red | The descriptor or its tests most likely have a bug. Comment once per head commit, tag the author and the maintainers, and count the runners like any other red check for the close rule below. |
| Every red check other than the two runners is red for more than N weeks and the author did nothing for more than N weeks | Close the pull request with a comment that lists the red checks and says how to reopen. When a merge of master adds a new red check, the CI result changed, and the author gets N weeks for it. |
| A reviewer requested changes and the author did nothing for more than N weeks | Close the pull request with a comment. This rule needs no red check. |
| The check `Attested descriptors are unchanged` is red | The pull request changes a descriptor that an auditor attested, and the fix is to delete the attestation files from `sigs/`. Comment once to ask the author for that. For the close rule, this check counts as red from the day of that comment, not before. |

N is 4 weeks by default. A pull request that matches both close rules gets one comment with both reasons. The script does one thing per pull request and run: a runner disagreement comes first, then the attestation question, then a close, then the comment for two red runners.

## What counts

- **Red**: a check with conclusion `FAILURE`, `TIMED_OUT`, `STARTUP_FAILURE` or `ERROR`. A cancelled run is not red. When the same check ran twice on the head commit, a passed run supersedes a failed one.
- **Red since**: a check is red since the oldest run that made it red. The script walks back along the previous head commits, ten at most, while the same check stays red. When a merge of master turns a green check red, the clock starts at that run, so the author gets N weeks to react. When the check was already red before the merge, the clock keeps running.
- **Ignored checks**: the optional AI Review workflow, the label bots (`PR Labels` and its predecessors), the `Descriptor Tests Queued` note and its predecessor `Clear Signing Tests Started`, and the `Notify fork PR` job of the old test workflow.
- **Author activity**: commits by the author, and comments, reviews and review replies by the author. Comments of bots and the merge commits a maintainer pushes with Update branch do not count, so a bulk Update branch does not reset the clock.
- **Waiting for a maintainer**: when the author acted after the last comment or review of a maintainer, the pull request is never closed, whatever the checks say. The ball is with the maintainer. A maintainer is a member or collaborator of the repository, by the author association GitHub attaches to every comment, or a login given with `--maintainers`. Comments of other people, of bots and of this script do not count as maintainer activity.
- **Drafts** are treated like any other pull request.

## Usage

The script needs the GitHub CLI (`gh`) logged in with write access to the repository. By default it is a dry run and only prints its plan.

```bash
# Print the plan
node .github/scripts/triage-red-prs.js

# Print the plan with the full text of every comment
node .github/scripts/triage-red-prs.js --verbose

# Post the comments and close the pull requests
node .github/scripts/triage-red-prs.js --apply

# Other options
node .github/scripts/triage-red-prs.js --weeks 6 --maintainers kuzdogan,manuelwedler --pr 2994 --pr 3005
```

Run the dry run first and read the plan: the script closes pull requests. It posts sequentially with a pause between calls, because GitHub applies a secondary rate limit to bursts of comments.

## In CI

The workflow `.github/workflows/triage-red-prs.yml` runs the dry run every Monday and writes the plan to the job summary, so the maintainers see it without a local setup. A manual run of the workflow with the `apply` input posts the comments and closes the pull requests. The comments then come from the GitHub Actions bot, which never counts as activity, so a run of the workflow does not reset any clock.

## Comments

Every comment ends with a link to this script, so a contributor knows where it came from. The runner comment carries a hidden marker with the head commit, which is how the script knows it already reported that commit. The attestation comment carries a marker without a commit, so it is posted once per pull request.
