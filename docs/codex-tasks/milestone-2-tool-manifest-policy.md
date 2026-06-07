# Milestone 2: Tool Manifest and Policy Engine

## Goal

Create a single source of truth for tools and replace static confirmation logic with a product-grade Policy / Approval Engine.

## Scope

Implement:

1. `defineTool` abstraction.
2. Central tool manifest.
3. Tool bundles metadata.
4. Automatic Realtime tool definition generation.
5. Automatic schema validation via manifest.
6. ApprovalPolicy based on tool risk and settings.
7. ActionPlan-based confirmation queue.

## Out of scope

Do not implement:

- Dynamic Realtime bundle switching.
- Codex coding-agent runtime.
- Electron Forge packaging.
- UI redesign.
- Large tool behavior rewrites.

## Required implementation details

### Tool definition

Add:

```ts
type ToolRisk =
  | "read"
  | "local_open"
  | "local_write"
  | "external_send"
  | "browser_submit"
  | "system_change"
  | "shell"
  | "coding_agent";
```

Each tool must define:

- name
- title
- description
- capability
- bundle
- risk
- zod schema
- realtime description
- summarize
- handler

### Manifest

Create domain manifests:

- core
- filesystem
- documents
- comms
- media
- desktop
- browser
- shell

### Confirmation

Replace static `toolsRequiringConfirmation` usage with approval policy.

High-risk tools should require confirmation unless explicitly allowed by policy:

- local_write
- external_send
- browser_submit
- system_change
- shell
- coding_agent

### ActionPlan

Confirmation queue should store an auditable `ActionPlan`, not a closure.

```ts
type ActionPlan = {
  id: string;
  toolName: ToolName;
  args: unknown;
  risk: ToolRisk;
  summary: string;
  preview?: unknown;
  reversible: boolean;
  createdAt: string;
  expiresAt: string;
};
```

## Suggested implementation path

1. Add `src/main/tools/define-tool.ts`.
2. Create a manifest for core + a few file tools first.
3. Update registry to execute from manifest.
4. Migrate all tools domain by domain.
5. Remove renderer-side tool name whitelist.
6. Introduce `src/main/policy/approval-policy.ts`.
7. Convert confirmation queue to ActionPlan.
8. Add tests.

## Acceptance criteria

- Adding a new tool requires editing only one manifest file.
- All tool names are unique.
- Realtime tool definitions are generated from manifest.
- Zod validation is generated from manifest.
- Unknown tool is rejected by runtime.
- Read-only tools do not require confirmation.
- High-risk tools require confirmation.
- Disabled capability denies tool execution.
- Unauthorized app denies app/window tools.
- Existing tools still work.
- `npm run build` passes.
- Tests cover tool uniqueness, schema validation, approval policy, and confirmation execution.

## Suggested files to inspect

- `src/shared/tools.ts`
- `src/main/tools/registry.ts`
- `src/main/tools/confirmation.ts`
- `src/main/capability-gate.ts`
- `src/main/settings-store.ts`
- `src/renderer/main.ts`

## Completion report

Report:

- Which tools migrated.
- Which old duplicate definitions were removed.
- Commands run.
- Any tools not fully migrated and why.
