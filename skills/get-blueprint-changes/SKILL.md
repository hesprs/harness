---
name: get-blueprint-changes
description: Inspect Git history and uncommitted changes to obtain delta in blueprint.
disable-model-invocation: true
---

1. List Git commit history with commit message headlines using `git log --oneline -n 10`.
2. Find all consecutive `blpt` commits starting from the most recent commit. The search should stop at the first non-`blpt` commit.
3. Use `git diff <hash of the commit prior than the first blpt>...HEAD -- blueprint/` to inspect the cumulative change to the blueprint.
4. If you find no qualified commits or the Git diff shows empty. Report back: "No committed changes to the blueprint found."
5. Read full documents in `blueprint` folder touched by the changes.
6. Inspect more blueprint to understand the structure of the change if needed.
7. Present the user with a detailed synthesis of the meaningful changes in blueprint documents.
8. Ask the user whether to progress to planning stage. If they answer yes, start a `make-plans` skill session about the changes proposed by the changes in blueprint.
