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
