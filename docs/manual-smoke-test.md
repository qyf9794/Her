# Manual Smoke Test

Use this checklist after `npm run check` passes.

## Setup

1. Start the app with `npm run dev`.
2. Complete onboarding if prompted.
3. Confirm the renderer connects to the local API.
4. Confirm voice can connect without exposing the OpenAI API key in renderer logs.

## Voice And Tools

1. Ask: `system_status`.
   - Expected: Her returns current runtime status.
2. Ask: `List my Desktop`.
   - Expected: file listing succeeds if file management is enabled.
3. Ask: `Create a folder on Desktop named Her Smoke Test`.
   - Expected: confirmation appears.
4. Reject the confirmation.
   - Expected: folder is not created.
5. Ask again and approve the confirmation.
   - Expected: folder is created.
6. Disable `fileManagement`.
   - Expected: file tools are denied.
7. Re-enable `fileManagement`.
   - Expected: file tools work again after confirmation where needed.

## Realtime Bundles

1. Ask a media command such as `播放周杰伦的晴天`.
   - Expected: media tools are available and the mini player reflects playback where supported.
2. Ask a browser command.
   - Expected: browser bundle is selected, high-risk submit actions require confirmation.
3. Ask an ambiguous command such as `处理一下那个`.
   - Expected: Her asks for clarification instead of guessing a destructive action.

## Task Runtime

1. Start a long coding-agent plan task.
   - Expected: task appears in Codex Runs and Tasks.
2. While it runs, ask `system_status`.
   - Expected: immediate tool still responds.
3. Start another coding task for the same repo.
   - Expected: same-repo work is serialized by the repo lock.

## Codex Review And Apply

1. Start a patch or test-fix coding-agent task against a disposable repo.
   - Expected: Codex runs in an isolated worktree, not the original checkout.
2. When the task completes, open `Review`.
   - Expected: changed files, test signals, follow-ups, and a bounded diff preview are visible.
3. Click `Apply`.
   - Expected: a high-risk confirmation appears with changed files and diff preview.
4. Reject the confirmation.
   - Expected: original checkout remains unchanged.
5. Click `Apply` again and approve.
   - Expected: selected file changes are copied from the worktree to the original checkout.

## Skills And Memory

1. Ask Her to remember a reusable workflow such as `以后我说准备开会，就创建会议文件夹`.
   - Expected: Her shows a skill preview with steps, capabilities, and risks.
2. Approve saving the skill.
   - Expected: skill appears in skill list and memory status reports the skill count.
3. Run the skill.
   - Expected: high-risk steps still request confirmation before side effects.
4. Try saving a skill or memory containing an API key or password.
   - Expected: Her rejects it before persistence.
5. Delete the skill.
   - Expected: deletion requires confirmation and the skill can no longer run.

## Workflow Packs

1. Open the Workflow Packs panel.
   - Expected: Focus Writing, Meeting Prep, Research Desk, Coding Session, and File Cleanup are listed.
2. Preview each pack.
   - Expected: trigger phrases, required capabilities, risks, ordered steps, and rollback notes are visible.
3. Preview File Cleanup with an explicit `targetPath`.
   - Expected: search is read-only and the Trash step is marked confirmation-required.
4. Run File Cleanup against a disposable file.
   - Expected: workflow status becomes `awaiting_confirmation`, the file is still present, and the run shows a confirmation id.
5. Cancel the workflow run.
   - Expected: pending confirmation is rejected or removed, the Trash step is cancelled, and the file is still present.
6. Run File Cleanup with a non-allowlisted root.
   - Expected: the search step fails visibly and the Trash step is skipped.

## YOLO Mode

1. Enable YOLO mode with an expiry.
2. Try a low-risk local open/write action.
   - Expected: allowed according to current policy.
3. Try shell, browser submit, external send, system change, or coding-agent action.
   - Expected: confirmation is still required.

## Packaging

1. Run `npm run package`.
2. Run `npm run make`.
3. Launch the generated app from `out/Her-darwin-x64/Her.app`.
   - Expected: app starts and uses packaged renderer assets.
