# Milestone 7: Workflow Skills and Local Memory

## Goal

Let users teach Her reusable local workflows without storing secrets or bypassing policy.

## Scope

1. Productize aliases into Her Skills:
   - named reusable local workflows
   - exact trigger phrase
   - parameter schema
   - one or more validated tool steps
2. Add skill preview before save.
3. Add skill permissions and risk metadata.
4. Add explicit save/list/inspect/run/delete tools.
5. Ensure skill execution goes through the same tool runtime and policy engine.
6. Prevent secret-like keys and values in skill definitions and memory.
7. Make memory status clearly report aliases, skills, and memory counts.

## Out of Scope

- Do not implement M8 workflow packs.
- Do not add opaque automatic memory capture.
- Do not store raw secrets, OAuth tokens, cookies, API keys, or local API tokens.
- Do not bypass confirmation for high-risk skill steps.

## Automatic Acceptance

- `npm run typecheck` passes.
- `npm run test` passes.
- `npm run build` passes.
- `npm run check` passes.
- Creating a skill requires confirmation.
- Skills cannot store secret-like keys or values.
- Skill execution goes through `ToolRegistry.execute` for every step.
- Skill list, inspect, run, and delete are covered by tests.
- Memory status reports memory counts plus alias and skill counts.

## Scenario Tests

1. Preview "准备开会" with calendar/note/window steps and verify permissions/risk metadata.
2. Approve saving the skill and verify it appears in skill list.
3. Run the skill and verify high-risk steps still return confirmation instead of silent execution.
4. Try to save a skill containing an API key and verify it is rejected.
5. Delete the skill and verify it can no longer run.
6. Ask "你记住了什么" and verify a compact memory status answer includes aliases, skills, and memory counts.

## Exit Criteria

Her becomes personalized through explicit, reviewable, local workflow skills rather than opaque memory.
