# Milestone 4: Codex Coding Agent MVP

## Goal

Integrate Codex as an asynchronous coding-agent task runtime, not as a generic shell command.

## Scope

Implement:

1. Coding agent task model.
2. Task store.
3. `codex exec --json` runner.
4. Git worktree isolation.
5. Environment sanitizer.
6. Coding agent Realtime tools.
7. Basic Agent Runs UI panel or API-only MVP.
8. Cancel/status/result APIs.

## Out of scope

Do not implement:

- Full Codex app-server integration.
- Full PR creation/push workflow.
- `danger-full-access`.
- Direct modification of original repo.
- Background daemon beyond current app process.

## Required implementation details

### Tools

Add tools:

- `coding_agent_start`
- `coding_agent_status`
- `coding_agent_continue`
- `coding_agent_cancel`
- `coding_agent_get_result`

`coding_agent_start` requires confirmation by default.

### Modes

Support:

- `plan`
- `review`
- `patch`
- `test_fix`

Defaults:

- plan/review → read-only
- patch/test_fix → workspace-write
- never default to danger-full-access

### Runner

Use:

```bash
codex exec --json --sandbox workspace-write --ask-for-approval on-request --ephemeral "<prompt>"
```

Use `spawn`, not `exec`.

Parse JSONL events.

### Worktree

Codex must run in an isolated worktree:

```text
~/.her/agent-runs/<taskId>/repo
```

Use branch:

```text
her/codex/<taskId>
```

### Env sanitizer

Do not pass:

- Her local API token
- Realtime secrets
- OAuth tokens
- cookies
- npm tokens
- arbitrary user env
- full `process.env`

## Suggested implementation path

1. Add shared coding-agent types.
2. Add task store.
3. Add worktree manager.
4. Add env sanitizer.
5. Add codex JSONL parser with tests.
6. Add codex exec runner.
7. Add API routes.
8. Add Realtime tools.
9. Add minimal Agent Runs UI.
10. Add tests.

## Acceptance criteria

- User can start a coding task.
- Task does not block Realtime voice.
- Task status is visible.
- Task can be cancelled.
- Codex runs inside isolated worktree.
- Secrets are not passed to Codex child process.
- `coding_agent_start` requires confirmation.
- `npm run build` passes.
- Tests cover:
  - worktree rejects non-git folder
  - env sanitizer removes secrets
  - task lifecycle
  - JSONL parser
  - cancel behavior

## Suggested files to inspect

- `src/main/tools/registry.ts`
- `src/main/tools/advanced-shell.ts`
- `src/main/tools/confirmation.ts`
- `src/renderer/main.ts`
- `package.json`

## Completion report

Report:

- How Codex is launched.
- How worktree isolation works.
- How env is sanitized.
- How cancellation works.
- Any missing Codex CLI dependency assumptions.
