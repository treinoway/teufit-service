# Cherry-pick current commit to staging

Cherry-pick the HEAD commit from the current branch onto `staging`, prefix the commit message with `[unmerged]`, and push to remote.

## Steps:

1. Get the current commit hash and message from HEAD
2. Switch to the `staging` branch (fetch and pull latest first)
3. Cherry-pick the commit (do NOT commit yet — use `--no-commit`)
4. Commit with the original message prefixed by `[unmerged] `
5. Push `staging` to remote
6. Switch back to the original branch

## Important:
- If there are uncommitted changes on the current branch, **abort and warn the user**
- If the cherry-pick has conflicts, **abort and warn the user** — do not force resolve
- Always return to the original branch at the end, even on failure

$ARGUMENTS
