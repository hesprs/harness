---
name: get-blueprint-changes
description: Inspect Git history and uncommitted changes to obtain delta in blueprint.
condition: Only when user instructs or other skill references.
disable-model-invocation: true
---

1. List Git commit history with commit message headlines using `git log --oneline -n 10`.
2. Find all consecutive `blpt` commits starting from the most recent commit. The search should stop at the first non-`blpt` commit.
3. Use `git diff <commit-hash>^!` on each of the qualified commits found.
4. Access uncommitted changes using `git diff HEAD && git ls-files --others --exclude-standard`.
5. If you find no qualified commits nor `blueprint` folder changes. Report back: "No changes to the blueprint found."
6. Read full documents in `blueprint` folder touched by commits and changes.
7. Inspect more blueprint to understand the structure of the change if needed.
8. Present the user with a detailed synthesis of the meaningful changes in blueprint documents.
9. Ask the user whether to progress to planning stage. If they answer yes, start a `write-plans` skill session about the changes proposed by the changes in blueprint.
