# Milestone 4.5: HER Task Runtime Concurrency

## Goal

Add a small product-grade Task Runtime so HER can accept multiple commands quickly, run non-conflicting work concurrently, serialize conflicting side effects, and keep Realtime voice responsive.

This milestone is not a planner. Realtime still understands the user and calls tools. HER owns task records, locks, queueing, cancellation, confirmation binding, and audit-safe status.

## Scope

Implement:

1. Shared task types.
2. Main-process task store with recent history persistence under Electron `userData`.
3. Resource lock manager.
4. Task classifier based on tool risk plus explicit lock rules.
5. Task queue/runner for selected pilot tools.
6. Task API routes:
   - `GET /api/tasks`
   - `GET /api/tasks/:id`
   - `GET /api/tasks/:id/events`
   - `POST /api/tasks/:id/cancel`
7. Realtime tools:
   - `task_list`
   - `task_status`
   - `task_cancel`
8. Confirmation-to-task binding for task-wrapped pilot tools.
9. Codex coding-agent task registration with repo resource locks.
10. Minimal renderer Task Panel.
11. Smoke tests for store, locks, classifier, queue, confirmation binding, and mixed concurrency.

## Out of scope

Do not implement:

- Planner / DAG execution.
- Multi-agent orchestration.
- Cloud or distributed queue.
- Full migration of every tool through TaskRuntime.
- Electron packaging.
- UI redesign.

## Task kinds

```ts
type HerTaskKind = "immediate" | "exclusive" | "long_running";
```

- `immediate`: short read/open actions that should not block queue work.
- `exclusive`: side-effecting actions with shared resources.
- `long_running`: Codex and future slow jobs that return taskId quickly.

## Resource locks

Use in-memory locks for active app process:

```text
file:<absolute-path>
folder:<absolute-folder>
repo:<absolute-repo-path>
browser:isolated-profile
email:outbox
calendar:primary
desktop:windows
system:settings
shell:local
```

Non-conflicting tasks may run concurrently. Conflicting tasks wait until locks release.

## Pilot wrapped tools

Wrap only:

- `file_rename`
- `file_move`
- `file_trash`
- `window_close_all`
- `advanced_shell_command`
- `coding_agent_start`

All other existing tool behavior remains unchanged.

## Safety rules

- Do not bypass ToolRegistry schema validation.
- Do not bypass CapabilityGate, app permissions, path allowlist, ApprovalPolicy, or confirmation queue.
- Confirmation records must carry `taskId` where applicable.
- Locks release on success, failure, rejection, and cancellation.
- Task history redacts secrets and truncates large args/results.
- Local task API routes require existing Local API auth.

## Acceptance criteria

- `npm run build` passes.
- Existing tool smoke still passes.
- Task store persists recent redacted history under userData.
- ResourceLockManager blocks conflicting locks and allows non-conflicting locks.
- TaskQueue runs non-conflicting pilot tasks concurrently and conflicting pilot tasks serially.
- `task_list`, `task_status`, `task_cancel`, and optional `task_events` are read/control tools.
- Pilot high-risk tools create task records and preserve confirmation.
- Rejecting confirmation does not execute the underlying action and releases locks.
- Approving confirmation executes the action and completes the task.
- `coding_agent_start` registers a long-running task and uses `repo:<repoPath>` lock.
- Music or other immediate tools are not blocked while Codex or pilot queued work runs.
- Renderer shows recent tasks and allows cancellation where supported.
