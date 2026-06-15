# Coding Agent

The coding-agent runtime connects Her to Codex for asynchronous repository work.

## Capabilities

Tools:

- `coding_agent_start`
- `coding_agent_status`
- `coding_agent_continue`
- `coding_agent_cancel`
- `coding_agent_get_result`
- `coding_agent_apply_to_repo`

Modes:

- `plan`
- `review`
- `patch`
- `test_fix`

## Isolation

Coding-agent tasks run in isolated git worktrees under `~/.her/agent-runs`. Patch-capable modes use workspace-write inside that isolated worktree, not the user's main checkout.

Codex child processes receive a sanitized environment. Secret-like environment variables are stripped.

## Confirmation

Starting and continuing coding-agent tasks are high-risk operations. They require confirmation and are tracked through the task runtime so same-repository long-running work uses a `repo:<path>` lock.

Applying Codex output back to the original repository is also high risk. Her first builds a review payload from the isolated worktree:

- changed files
- bounded diff preview
- test signals found in Codex output
- follow-up suggestions

`coding_agent_apply_to_repo` copies selected file changes from the worktree into the original checkout only after explicit confirmation. The apply path refuses unsafe relative paths and non-file worktree entries.

## Defaults

Default tests do not run real Codex. Smoke tests cover parser, task store, worktree rejection, review/apply adapters, fake runner cancellation, and lifecycle behavior.
