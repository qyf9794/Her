# AGENTS.md

## Project

Her is an Electron + Vite + TypeScript local voice desktop agent using GPT Realtime.

The product goal is to become a local Agent Runtime with a secure tool execution layer, permission policy, confirmation UI, dynamic Realtime tool bundles, and future Codex coding-agent runtime.

## Non-negotiable rules

- Do not remove existing user-facing functionality unless the current task explicitly says so.
- Do not expose `OPENAI_API_KEY`, Realtime secrets, local API tokens, OAuth tokens, cookies, or credentials to the renderer, logs, transcripts, test snapshots, or Codex child processes.
- Do not set `Access-Control-Allow-Origin` to `*`.
- Do not allow arbitrary webpages to call Her local tool APIs.
- Do not bypass tool confirmation for high-risk actions.
- Do not treat YOLO mode as permission to run shell, browser submit, external send, system change, or coding-agent operations without explicit confirmation unless the task explicitly implements a safer YOLO policy.
- Do not use `danger-full-access` unless the user explicitly requests it.
- Do not implement multiple milestones in one pass.
- Do not perform large unrelated formatting changes.
- Prefer small, reviewable commits.

## Required workflow

Before editing code:

1. Read `AGENTS.md`.
2. Read `docs/productization-plan.md`.
3. Read the current milestone file under `docs/codex-tasks/`.
4. Inspect the current files relevant to the milestone.
5. Produce a short implementation plan.
6. Implement only the requested milestone or subtask.

After editing code:

1. Run typecheck, tests, and build where available.
2. Report changed files.
3. Report commands run and results.
4. Report any skipped checks and why.
5. Report risks and follow-up tasks.

## Commands

Use these when available:

```bash
npm run build
npm run typecheck
npm run test
npm run check
```

If a command does not exist yet, do not invent success. Add it only when the current milestone asks for it.

## Architecture direction

Target architecture:

- Electron shell should stay thin.
- Renderer should not own security boundaries.
- Local tool execution must happen behind Policy Engine and Approval Policy.
- Tool definitions should have a single source of truth.
- Realtime should use core tools plus dynamic bundles.
- Codex should be integrated as an asynchronous coding-agent runtime, not as a generic shell command.

## Safety

When in doubt, choose the safer path and leave a TODO with rationale.

## Subagents

Use Codex subagents for analysis and review only unless the user explicitly asks otherwise.

Recommended subagent uses:

- Codebase exploration.
- Security review.
- Test gap analysis.
- Diff review.

Do not let multiple subagents edit the same files in parallel.
