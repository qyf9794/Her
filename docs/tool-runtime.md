# Tool Runtime

The tool runtime is centered on the Tool Manifest. Tool definitions, schemas, groups, risks, summaries, and Realtime definitions are generated from the manifest path rather than duplicated in the renderer.

## Execution Flow

1. Realtime or local API requests a tool call.
2. `ToolRegistry` validates the tool name.
3. Zod schema validates arguments.
4. Capability gate checks feature-level and app-level permission.
5. Approval policy decides allow, deny, or confirmation.
6. Low-risk handlers run immediately.
7. High-risk handlers produce an `ActionPlan`.
8. Confirmed plans execute through the same main-process handlers.

## Task Runtime

M4.5 introduced Her tasks for concurrent work:

- `TaskStore`: persists recent task history and events under user data.
- `TaskQueue`: runs non-conflicting tasks concurrently.
- `ResourceLockManager`: prevents conflicting operations on the same resource.
- `TaskClassifier`: marks selected tools as immediate, exclusive, or long-running.

Pilot managed tools include file rename/move/trash, close-all windows, advanced shell, and coding-agent start.

## Regression Gates

Default tests cover manifest uniqueness, bundle routing, policy confirmation, capability denial, local API auth, confirmation approve/reject, malformed args, Codex parser, and secret redaction.

M6 adds Codex review/apply coverage. Completed coding-agent tasks can produce structured review artifacts from isolated worktrees, and applying those changes to the original repository is a separate confirmation-gated tool call.

## Her Skills

M7 adds reusable local workflow skills:

- `skill_preview` validates a proposed skill and returns step summaries, risks, and required capabilities.
- `skill_save` persists the skill only after confirmation.
- `skill_run` expands the skill and sends each step back through `ToolRegistry.execute`, so capability checks, path checks, approval policy, task runtime, and confirmation still apply.
- `skill_delete` requires confirmation before removing the saved workflow.

Skills are explicit local memory. They may include parameter placeholders such as `{{folder}}`, but they cannot store secret-like keys or values.

## Workflow Packs

M8 adds built-in workflow packs for signature desktop modes:

- Focus Writing
- Meeting Prep
- Research Desk
- Coding Session
- File Cleanup

Workflow packs are fixed product manifests, not user-editable custom workflows. Each pack exposes trigger phrases, required capabilities, risks, ordered steps, and rollback notes. `workflow_pack_preview` shows the full plan before execution. `workflow_pack_run` creates a grouped workflow run with visible step events, then sends each step through `ToolRegistry.execute` so capability gates, task runtime, and high-risk confirmation still apply.

Workflow cancellation rejects any pending workflow confirmation when possible and marks remaining steps cancelled or skipped. File Cleanup is intentionally explicit: it searches candidates first and only moves `targetPath` to Trash after the normal file confirmation flow.
