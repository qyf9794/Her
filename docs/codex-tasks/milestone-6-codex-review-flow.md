# Milestone 6: Codex Delegation Artifacts and Review Flow

## Goal

Turn Codex from an asynchronous text result into a safe delegated coding workflow with reviewable worktree output and confirmation-gated apply.

## Scope

1. Add a Codex artifact adapter that summarizes:
   - changed files
   - diff preview
   - test signals
   - follow-up suggestions
2. Store the review payload on coding-agent tasks.
3. Include the review payload in coding-agent result artifacts.
4. Add an apply workflow that copies selected worktree changes back to the original repository only after explicit confirmation.
5. Add renderer controls for viewing Codex review output and requesting apply.
6. Preserve isolated worktree defaults and sandbox choices.

## Out of Scope

- Do not run real Codex in default tests.
- Do not implement multi-branch merge conflict resolution.
- Do not implement remote PR creation.
- Do not implement M7 skills or memory work.

## Automatic Acceptance

- `npm run typecheck` passes.
- `npm run test` passes.
- `npm run build` passes.
- `npm run check` passes.
- `npm run smoke:m4` passes.
- `npm run smoke:m4-5` passes.
- Plan/review modes use read-only sandbox.
- Patch/test-fix modes use workspace-write sandbox inside the isolated worktree.
- Codex child process receives sanitized env only.
- Applying Codex output to the original repo requires confirmation.
- Apply preview includes changed files and a bounded diff.
- Cancelling a running Codex task updates coding-agent status and Her task status.

## Scenario Tests

1. Start "review this repo" and verify no files are modified in the original checkout.
2. Start "fix failing tests" and verify Codex runs in a worktree.
3. Cancel a running task and verify status is cancelled.
4. Start two patch tasks for the same repo and verify the second waits on the repo lock.
5. Approve applying a small worktree diff and verify the original repo changes only after confirmation.

## Exit Criteria

Her can safely use Codex as a coding worker without becoming "voice Codex": Codex works in an isolated worktree, Her shows reviewable outputs, and the original checkout changes only through confirmation-gated apply.
