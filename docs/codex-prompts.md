# Codex 使用提示词

## 第一次：只落文档，不改 runtime

```text
Read the current repository.

I want to productize Her in small safe milestones.

First task:
1. Create or update `docs/productization-plan.md` using the full productization plan already in this repository.
2. Create or update `AGENTS.md` with project rules for future Codex runs.
3. Create or update `docs/codex-tasks/milestone-1-local-api-security.md`.
4. Do not change application runtime code in this task.
5. After creating the files, run `npm run build` if possible and report the result.

Important:
- Do not implement the plan yet.
- Do not modify tool runtime, Realtime, server, renderer, or package scripts yet.
- This task is documentation and execution setup only.
```

## 第二次：实施 Milestone 1

```text
Implement only `docs/codex-tasks/milestone-1-local-api-security.md`.

Before editing:
- Read `AGENTS.md`.
- Read `docs/productization-plan.md`.
- Read `docs/codex-tasks/milestone-1-local-api-security.md`.
- Inspect the existing server, renderer API calls, and Realtime client-secret flow.
- Give me a short implementation plan.

Implementation constraints:
- Do not implement Tool Manifest.
- Do not implement Policy Engine.
- Do not implement dynamic Realtime bundles.
- Do not implement Codex coding-agent.
- Do not rewrite the UI.
- Preserve current behavior.
- Keep changes small and reviewable.

After editing:
- Run `npm run build`.
- If you add tests and a test script exists, run tests.
- Report changed files, commands run, results, and any risks.
```

## 使用子代理的提示词

```text
Use subagents for analysis only.

Spawn:
1. An explorer subagent to map the current local API/server/renderer request flow.
2. A security reviewer subagent to identify risks in the planned local API token and CORS changes.

Wait for both subagents to return.
Then the main agent should implement only the current milestone.

Do not let subagents edit files.
Only the main agent may edit files.
```

## 通用任务模板

```text
Task: Implement [Milestone/Subtask Name]

Read first:
- AGENTS.md
- docs/productization-plan.md
- docs/codex-tasks/[current-task].md
- Relevant source files

Scope:
- Implement only [specific scope]

Out of scope:
- Do not implement [list]

Acceptance criteria:
- [copy exact criteria]

Process:
1. Inspect files.
2. Produce a short plan.
3. Implement.
4. Run checks.
5. Report changed files and risks.

Subagents:
- Use subagents for analysis/review only.
- Do not let subagents edit files.
- Main agent performs all edits.
```
