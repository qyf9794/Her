# Simple Command Milestone Test Log

Branch: `codex/simple-command-milestone-tests`

Goal:

- Test simple-command milestones one by one.
- Record concrete successes and failures.
- Fix failures when possible.
- Record external or platform blockers when they cannot be fixed locally.

## Current Status

| Milestone | Scope | Status | Evidence |
| --- | --- | --- | --- |
| S0 | Intent card harness, no Realtime-2, no real tools | Passed after fix | `docs/test-runs/simple-command-intent-cards/S0-intent-card-report.json` |
| S1 | App and window commands | Passed after fixes | `docs/test-runs/simple-command-desktop/S1-desktop-window-report.json` |
| S2 | Files and documents | Not started | Pending sandbox fixture simulation |
| S3 | Browser and page commands | Not started | Pending local fixture page simulation |
| S4 | Music, media, and video | Not started | Apple Music developer token ready; user MusicKit authorization still manual |
| S5 | System, clipboard, notification, speech, screenshot | Not started | Pending safe system simulation |
| S6 | Mail, calendar, reminders, notes, copy drafts | Not started | Pending `[Her Test]` namespace simulation |
| S7 | Task, confirmation, and low-risk shell | Not started | Pending policy/runtime simulation |
| S8 | Negative, safety, and clarification | Not started | Pending denial/clarification verification |
| S9 | Full suite report and cleanup | Not started | Pending S1-S8 |

## 2026-06-15 S0: Intent Card Harness

### Test Plan Reference

`docs/codex-tasks/simple-command-intent-card-test-plan.md`

### Commands Run

```bash
npm run test:commands
npm run test:intent-cards
npm run test
```

### Initial Baseline

`npm run test:commands`

Result:

- Passed.
- 62 command fixtures completed dry-run routing without Realtime-2 or tool side effects.
- Console report showed all fixture statuses as `passed`.

### First S0 Report Attempt

`npm run test:intent-cards`

Result:

- Failed.
- Report path was created: `docs/test-runs/simple-command-intent-cards/S0-intent-card-report.json`.
- Summary: 62 total, 49 passed, 13 failed.

Failures:

| Failure | Cause | Fix |
| --- | --- | --- |
| Clarification cards missing `clarificationQuestion` | Intent card generator produced `missingInfo` but no user-facing question | Added `clarificationQuestionFor()` |
| Denial cards missing `denialReason` | Intent card generator marked denial but did not explain why | Added `denialReasonFor()` |
| Secret-like negative alias card failed redaction check | Secret detector treated some redacted/key-name text too broadly | Split redaction patterns from unredacted-secret detection |

Affected examples:

- `desktop.ambiguous.zh.001`
- `browser.click_submit.zh.001`
- `clarify.thing.zh.001`
- `file.outside_allowlist.zh.001`
- `system.shell.danger.zh.001`
- `alias.secret.negative.zh.001`
- `negative.secret_alias.zh.001`

### Fixes Applied

Files changed:

- `scripts/simple-command-intent-report.mjs`
- `tests/intent-card-report.test.ts`
- `package.json`

Fix details:

- Added an S0 report generator that outputs intent cards for all existing command fixtures.
- Added contract validation for card type, risk, confirmation behavior, missing information, denial reason, and secret leakage.
- Added `npm run test:intent-cards`.
- Added a Vitest test so `npm run test` verifies the S0 report contract.

### Retest

`npm run test:intent-cards`

Result:

- Passed.
- Report summary:
  - Total: 62
  - Passed: 62
  - Failed: 0
  - Executable cards: 49
  - Clarification cards: 6
  - Denial cards: 7
  - Realtime-2 connected: false
  - Real tools executed: false

Risk coverage:

- `local_open`: 21
- `system_change`: 9
- `read`: 12
- `local_write`: 9
- `browser_submit`: 2
- `external_send`: 3
- `shell`: 3
- `coding_agent`: 3

`npm run test`

Result:

- Passed.
- 11 test files passed.
- 68 tests passed.

### Remaining S0 Notes

- S0 proves deterministic intent-card generation and contract validation.
- S0 does not prove real desktop/browser/system outcomes; those begin in S1.
- The report intentionally redacts secret-like content and does not include private keys, local API tokens, or developer tokens.

## External / Manual Authorization Notes

Apple Music preparation status:

- MusicKit Key ID and `.p8` path are configured in ignored local `.env.local`.
- Apple Music Team ID was verified by a 200 response from the Apple Music Catalog API.
- Developer token generation works locally.
- User MusicKit authorization still requires manual Apple ID authorization in the Electron app window.

This is not a code failure. Apple requires the user authorization step for account-level MusicKit access.

## 2026-06-15 S1: App and Window Commands

### Test Plan Reference

`docs/codex-tasks/simple-command-intent-card-test-plan.md`

### Commands Run

```bash
npm run test:desktop:s1
npx tsc -p electron/tsconfig.json --noEmit
```

### First S1 Attempt

`npm run test:desktop:s1`

Result:

- Failed.
- Summary: 9 total, 4 passed, 4 failed, 1 skipped.

Failures:

| Failure | Cause | Fix |
| --- | --- | --- |
| `S1.window.list` listed 0 TextEdit test windows | `SystemControl.listWindows()` scanned every visible app and was unreliable/slow in a busy desktop session | Added target app filtering to `SystemControl.listWindows(appNames)` and made `ToolRegistry.listAuthorizedWindows()` pass authorized app names before scanning |
| `S1.window.move-resize` could not verify geometry | Depended on the same unfiltered window list | Same filtered `listWindows(["TextEdit"])` fix |
| `S1.window.auto-arrange-10` arranged 0 windows | Allowed-app AppleScript branch used a fragile process lookup pattern | Rewrote allowed-app branches to target `tell process appName` directly |
| `S1.window.minimize-unrelated` preserved 0 windows | Same allowed-app branch issue plus unstable test window names | Rewrote allowed-app branch and changed test window creation to saved named TextEdit documents |

Safety finding fixed:

- Batch window scripts previously skipped `Electron`, `HER`, and `Her Voice Agent`, but did not explicitly skip `Codex`.
- Added `Codex` to protected `skippedApps` lists so close/hide/minimize/arrange batch flows avoid Codex.

### Test Harness Fixes

Files changed:

- `scripts/simple-command-s1-desktop-report.mjs`
- `package.json`

Details:

- Added `npm run test:desktop:s1`.
- S1 uses the compiled project `SystemControl` implementation, not a fake window runner.
- S1 creates disposable TextEdit `.rtf` documents named `Her S1 Keep.rtf` and `Her S1 Other NN.rtf`.
- S1 refuses to proceed if pre-existing TextEdit windows are present, to avoid closing user documents.
- S1 cleans up only the disposable TextEdit session it owns.

### Final Retest

`npm run test:desktop:s1`

Result:

- Passed.
- Summary:
  - Total: 9
  - Passed: 8
  - Failed: 0
  - Skipped: 1
  - Blocked: 0

Passed scenarios:

- `S1.preflight.accessibility`: System Events can inspect frontmost and visible application processes.
- `S1.protection.codex-skipped`: batch window scripts protect Codex.
- `S1.app.open-focus`: TextEdit opens and becomes frontmost.
- `S1.window.list`: 10 disposable TextEdit windows are listed.
- `S1.window.move-resize`: a TextEdit window moves near `80,80` and resizes near `800x600`.
- `S1.window.auto-arrange-10`: 10 windows arrange successfully with layout `4x3`.
- `S1.window.minimize-unrelated`: 1 named keep window is preserved and 9 unrelated windows are minimized.
- `S1.desktop.show`: macOS Show Desktop shortcut is sent without closing apps.

Skipped scenario:

- `S1.excluded.close-all`: `window_close_all` was not executed in unattended S1 because it can disrupt user context. This remains a high-risk confirmation/manual scenario.

### Remaining S1 Notes

- S1 proves real local desktop window behavior using disposable windows.
- S1 does not execute real close-all. This is an intentional safety skip, not a product failure.
- The desktop environment must grant Accessibility/System Events access. In this run, access was available.

## S2 Files and Documents - Failed

Report: `docs/test-runs/simple-command-files/S2-files-documents-report.json`

- Total scenarios: 13
- Passed: 12
- Failed: 1
- Sandbox root: `/Users/qianyifeng/Desktop/Her S2 Files Sandbox 1781540070027` (removed after run)
- Real execution: file list/search/read/open/create/rename/copy/move/trash plus document extract/folder digest/prepare edit.
- Safety checks: write operations stayed under the disposable Desktop sandbox; `file_trash` required confirmation before the script executed the sandbox trash; fake `.p8`, API key, bearer token, and private key contents were denied or redacted.

## S2 Files and Documents - Passed

Report: `docs/test-runs/simple-command-files/S2-files-documents-report.json`

- Total scenarios: 13
- Passed: 13
- Failed: 0
- Sandbox root: `/Users/qianyifeng/Desktop/Her S2 Files Sandbox 1781540089291` (removed after run)
- Real execution: file list/search/read/open/create/rename/copy/move/trash plus document extract/folder digest/prepare edit.
- Safety checks: write operations stayed under the disposable Desktop sandbox; `file_trash` required confirmation before the script executed the sandbox trash; fake `.p8`, API key, bearer token, and private key contents were denied or redacted.

## S2 Files and Documents - Passed

Report: `docs/test-runs/simple-command-files/S2-files-documents-report.json`

- Total scenarios: 13
- Passed: 13
- Failed: 0
- Sandbox root: `/Users/qianyifeng/Desktop/Her S2 Files Sandbox 1781540355779` (removed after run)
- Real execution: file list/search/read/open/create/rename/copy/move/trash plus document extract/folder digest/prepare edit.
- Safety checks: write operations stayed under the disposable Desktop sandbox; `file_trash` required confirmation before the script executed the sandbox trash; fake `.p8`, API key, bearer token, and private key contents were denied or redacted.

## S2 Files and Documents - Passed

Report: `docs/test-runs/simple-command-files/S2-files-documents-report.json`

- Total scenarios: 13
- Passed: 13
- Failed: 0
- Sandbox root: `/Users/qianyifeng/Desktop/Her S2 Files Sandbox 1781540704084` (removed after run)
- Real execution: file list/search/read/open/create/rename/copy/move/trash plus document extract/folder digest/prepare edit.
- Safety checks: write operations stayed under the disposable Desktop sandbox; `file_trash` required confirmation before the script executed the sandbox trash; fake `.p8`, API key, bearer token, and private key contents were denied or redacted.

## S2 Files and Documents - Passed

Report: `docs/test-runs/simple-command-files/S2-files-documents-report.json`

- Total scenarios: 13
- Passed: 13
- Failed: 0
- Sandbox root: `/Users/qianyifeng/Desktop/Her S2 Files Sandbox 1781540825807` (removed after run)
- Real execution: file list/search/read/open/create/rename/copy/move/trash plus document extract/folder digest/prepare edit.
- Safety checks: write operations stayed under the disposable Desktop sandbox; `file_trash` required confirmation before the script executed the sandbox trash; fake `.p8`, API key, bearer token, and private key contents were denied or redacted.

## S3 Browser and Page Commands - Failed

Report: `docs/test-runs/simple-command-browser/S3-browser-page-report.json`

- Total scenarios: 10
- Passed: 5
- Failed: 5
- Realtime-2 connected: false
- Real execution: isolated Chrome open/read/fill/click/video-state/move-resize against local fixture pages plus deterministic search URL opening.
- Safety checks: external submit was stopped at `browser_click` confirmation; arbitrary web origins remain blocked from local tool API access.

## S3 Browser and Page Commands - Failed

Report: `docs/test-runs/simple-command-browser/S3-browser-page-report.json`

- Total scenarios: 10
- Passed: 4
- Failed: 6
- Realtime-2 connected: false
- Real execution: isolated Chrome open/read/fill/click/video-state/move-resize against local fixture pages plus deterministic search URL opening.
- Safety checks: external submit was stopped at `browser_click` confirmation; arbitrary web origins remain blocked from local tool API access.

## S3 Browser and Page Commands - Passed

Report: `docs/test-runs/simple-command-browser/S3-browser-page-report.json`

- Total scenarios: 10
- Passed: 10
- Failed: 0
- Realtime-2 connected: false
- Real execution: isolated Chrome open/read/fill/click/video-state/move-resize against local fixture pages plus deterministic search URL opening.
- Safety checks: external submit was stopped at `browser_click` confirmation; arbitrary web origins remain blocked from local tool API access.

## S3 Browser and Page Commands - Passed

Report: `docs/test-runs/simple-command-browser/S3-browser-page-report.json`

- Total scenarios: 10
- Passed: 10
- Failed: 0
- Realtime-2 connected: false
- Real execution: isolated Chrome open/read/fill/click/video-state/move-resize against local fixture pages plus deterministic search URL opening.
- Safety checks: external submit was stopped at `browser_click` confirmation; arbitrary web origins remain blocked from local tool API access.

## S3 Browser and Page Commands - Passed

Report: `docs/test-runs/simple-command-browser/S3-browser-page-report.json`

- Total scenarios: 10
- Passed: 10
- Failed: 0
- Realtime-2 connected: false
- Real execution: isolated Chrome open/read/fill/click/video-state/move-resize against local fixture pages plus deterministic search URL opening.
- Safety checks: external submit was stopped at `browser_click` confirmation; arbitrary web origins remain blocked from local tool API access.

## S3 Browser and Page Commands - Passed

Report: `docs/test-runs/simple-command-browser/S3-browser-page-report.json`

- Total scenarios: 10
- Passed: 10
- Failed: 0
- Realtime-2 connected: false
- Real execution: isolated Chrome open/read/fill/click/video-state/move-resize against local fixture pages plus deterministic search URL opening.
- Safety checks: external submit was stopped at `browser_click` confirmation; arbitrary web origins remain blocked from local tool API access.

## S4 Music, Media, and Video - Passed

Report: `docs/test-runs/simple-command-media/S4-media-video-report.json`

- Total scenarios: 11
- Passed: 11
- Failed: 0
- Realtime-2 connected: false
- Real execution: Music app open/search/state, Spotify missing-config handling, NetEase and QQ Music search opening, media-key safety preflight, YouTube isolated search, and controlled local video state.
- Safety checks: Spotify tokens were blanked for fixture testing; media keys were not sent without a visible target app; MusicKit private key material was not read into the report.

## S5 System, Clipboard, Notification, Speech, and Screenshot - Failed

Report: `docs/test-runs/simple-command-system/S5-system-desktop-report.json`

- Total scenarios: 12
- Passed: 10
- Failed: 2
- Realtime-2 connected: false
- Real execution: volume read/set/mute, dark mode toggle with restore, Sound settings open, clipboard fixture write/read, speech, notification, screenshot artifact, and Escape shortcut.
- Safety checks: brightness reports platform limitation when the CLI is unavailable; lock screen required confirmation and was not executed; original volume, mute, dark mode, and clipboard state were restored.

## S5 System, Clipboard, Notification, Speech, and Screenshot - Passed

Report: `docs/test-runs/simple-command-system/S5-system-desktop-report.json`

- Total scenarios: 12
- Passed: 12
- Failed: 0
- Realtime-2 connected: false
- Real execution: volume read/set/mute, dark mode toggle with restore, Sound settings open, clipboard fixture write/read, speech, notification, screenshot artifact, and Escape shortcut.
- Safety checks: brightness reports platform limitation when the CLI is unavailable; lock screen required confirmation and was not executed; original volume, mute, dark mode, and clipboard state were restored.

## S6 Mail, Calendar, Reminders, Notes, and Copy Drafts - Failed

Report: `docs/test-runs/simple-command-productivity/S6-productivity-report.json`

- Total scenarios: 11
- Passed: 9
- Failed: 2
- Realtime-2 connected: false
- Real execution: local email draft/search/read, local calendar create/search, local copy draft save/search, and macOS Reminders/Notes create-cleanup when automation is available.
- Safety checks: Mail draft, email send, macOS Calendar creation, and copy publish stopped at confirmation; local adapter data files were restored after the run.

## S6 Mail, Calendar, Reminders, Notes, and Copy Drafts - Passed

Report: `docs/test-runs/simple-command-productivity/S6-productivity-report.json`

- Total scenarios: 11
- Passed: 11
- Failed: 0
- Realtime-2 connected: false
- Real execution: local email draft/search/read, local calendar create/search, local copy draft save/search, and macOS Reminders/Notes create-cleanup when automation is available.
- Safety checks: Mail draft, email send, macOS Calendar creation, and copy publish stopped at confirmation; local adapter data files were restored after the run.

## S7 Task, Confirmation, and Low-Risk Shell - Failed

Report: `docs/test-runs/simple-command-runtime/S7-task-confirmation-shell-report.json`

- Total scenarios: 8
- Passed: 5
- Failed: 3
- Realtime-2 connected: false
- Real execution: queued task list/status/cancel, confirmation list/reject/approve, approved bounded read-only shell, approved harmless folder creation, and dangerous shell validator failure.
- Safety checks: npm test and coding-agent start were confirmation-only and rejected; rejected confirmations produced no side effects; destructive shell did not remove the fixture folder.

## S7 Task, Confirmation, and Low-Risk Shell - Failed

Report: `docs/test-runs/simple-command-runtime/S7-task-confirmation-shell-report.json`

- Total scenarios: 8
- Passed: 7
- Failed: 1
- Realtime-2 connected: false
- Real execution: queued task list/status/cancel, confirmation list/reject/approve, approved bounded read-only shell, approved harmless folder creation, and dangerous shell validator failure.
- Safety checks: npm test and coding-agent start were confirmation-only and rejected; rejected confirmations produced no side effects; destructive shell did not remove the fixture folder.

## S7 Task, Confirmation, and Low-Risk Shell - Failed

Report: `docs/test-runs/simple-command-runtime/S7-task-confirmation-shell-report.json`

- Total scenarios: 8
- Passed: 7
- Failed: 1
- Realtime-2 connected: false
- Real execution: queued task list/status/cancel, confirmation list/reject/approve, approved bounded read-only shell, approved harmless folder creation, and dangerous shell validator failure.
- Safety checks: npm test and coding-agent start were confirmation-only and rejected; rejected confirmations produced no side effects; destructive shell did not remove the fixture folder.

## S7 Task, Confirmation, and Low-Risk Shell - Failed

Report: `docs/test-runs/simple-command-runtime/S7-task-confirmation-shell-report.json`

- Total scenarios: 8
- Passed: 7
- Failed: 1
- Realtime-2 connected: false
- Real execution: queued task list/status/cancel, confirmation list/reject/approve, approved bounded read-only shell, approved harmless folder creation, and dangerous shell validator failure.
- Safety checks: npm test and coding-agent start were confirmation-only and rejected; rejected confirmations produced no side effects; destructive shell did not remove the fixture folder.

## S7 Task, Confirmation, and Low-Risk Shell - Passed

Report: `docs/test-runs/simple-command-runtime/S7-task-confirmation-shell-report.json`

- Total scenarios: 8
- Passed: 8
- Failed: 0
- Realtime-2 connected: false
- Real execution: queued task list/status/cancel, confirmation list/reject/approve, approved bounded read-only shell, approved harmless folder creation, and dangerous shell validator failure.
- Safety checks: npm test and coding-agent start were confirmation-only and rejected; rejected confirmations produced no side effects; destructive shell did not remove the fixture folder.

## S8 Negative, Safety, and Clarification - Failed

Report: `docs/test-runs/simple-command-safety/S8-negative-safety-report.json`

- Total scenarios: 5
- Passed: 3
- Failed: 2
- Realtime-2 connected: false
- Real execution: generated negative intent cards, extracted a prompt-injection document as text, attempted and denied a credential-like file read, checked payment-submit confirmation, and validated rm -rf / blocking.
- Safety checks: no unsafe side effect occurred; secret fixture content was not written to the report.

## S8 Negative, Safety, and Clarification - Passed

Report: `docs/test-runs/simple-command-safety/S8-negative-safety-report.json`

- Total scenarios: 5
- Passed: 5
- Failed: 0
- Realtime-2 connected: false
- Real execution: generated negative intent cards, extracted a prompt-injection document as text, attempted and denied a credential-like file read, checked payment-submit confirmation, and validated rm -rf / blocking.
- Safety checks: no unsafe side effect occurred; secret fixture content was not written to the report.

## S8 Negative, Safety, and Clarification - Passed

Report: `docs/test-runs/simple-command-safety/S8-negative-safety-report.json`

- Total scenarios: 5
- Passed: 5
- Failed: 0
- Realtime-2 connected: false
- Real execution: generated negative intent cards, extracted a prompt-injection document as text, attempted and denied a credential-like file read, checked payment-submit confirmation, and validated rm -rf / blocking.
- Safety checks: no unsafe side effect occurred; secret fixture content was not written to the report.

## S8 Negative, Safety, and Clarification - Passed

Report: `docs/test-runs/simple-command-safety/S8-negative-safety-report.json`

- Total scenarios: 5
- Passed: 5
- Failed: 0
- Realtime-2 connected: false
- Real execution: generated negative intent cards, extracted a prompt-injection document as text, attempted and denied a credential-like file read, checked payment-submit confirmation, and validated rm -rf / blocking.
- Safety checks: no unsafe side effect occurred; secret fixture content was not written to the report.

## S9 Full Suite Report and Cleanup - Failed

Report: `docs/test-runs/simple-command-full-suite/S9-full-suite-report.md`

- Total scenarios/cards: 141
- Passed: 140
- Failed: 0
- Skipped: 1
- Unsupported: 0
- Blocked: 0
- Realtime-2 connected: false
- Cleanup checks: S3/S4 isolated Chrome profiles not running; screenshot PNGs ignored; report secret scan failed.

## S9 Full Suite Report and Cleanup - Passed

Report: `docs/test-runs/simple-command-full-suite/S9-full-suite-report.md`

- Total scenarios/cards: 141
- Passed: 140
- Failed: 0
- Skipped: 1
- Unsupported: 0
- Blocked: 0
- Realtime-2 connected: false
- Cleanup checks: S3/S4 isolated Chrome profiles not running; screenshot PNGs ignored; report secret scan passed.

## S2 Files and Documents - Passed

Report: `docs/test-runs/simple-command-files/S2-files-documents-report.json`

- Total scenarios: 13
- Passed: 13
- Failed: 0
- Sandbox root: `/Users/qianyifeng/Desktop/Her S2 Files Sandbox 1781544887988` (removed after run)
- Real execution: file list/search/read/open/create/rename/copy/move/trash plus document extract/folder digest/prepare edit.
- Safety checks: write operations stayed under the disposable Desktop sandbox; `file_trash` required confirmation before the script executed the sandbox trash; fake `.p8`, API key, bearer token, and private key contents were denied or redacted.

## S3 Browser and Page Commands - Failed

Report: `docs/test-runs/simple-command-browser/S3-browser-page-report.json`

- Total scenarios: 10
- Passed: 9
- Failed: 1
- Realtime-2 connected: false
- Real execution: isolated Chrome open/read/fill/click/video-state/move-resize against local fixture pages plus deterministic search URL opening.
- Safety checks: external submit was stopped at `browser_click` confirmation; arbitrary web origins remain blocked from local tool API access.

## S3 Browser and Page Commands - Passed

Report: `docs/test-runs/simple-command-browser/S3-browser-page-report.json`

- Total scenarios: 10
- Passed: 9
- Failed: 0
- Blocked: 1
- Realtime-2 connected: false
- Real execution: isolated Chrome open/read/fill/click/video-state/move-resize against local fixture pages plus deterministic search URL opening.
- Safety checks: external submit was stopped at `browser_click` confirmation; arbitrary web origins remain blocked from local tool API access.

## S4 Music, Media, and Video - Passed

Report: `docs/test-runs/simple-command-media/S4-media-video-report.json`

- Total scenarios: 11
- Passed: 11
- Failed: 0
- Realtime-2 connected: false
- Real execution: Music app open/search/state, Spotify missing-config handling, NetEase and QQ Music search opening, media-key safety preflight, YouTube isolated search, and controlled local video state.
- Safety checks: Spotify tokens were blanked for fixture testing; media keys were not sent without a visible target app; MusicKit private key material was not read into the report.

## S5 System, Clipboard, Notification, Speech, and Screenshot - Passed

Report: `docs/test-runs/simple-command-system/S5-system-desktop-report.json`

- Total scenarios: 12
- Passed: 12
- Failed: 0
- Realtime-2 connected: false
- Real execution: volume read/set/mute, dark mode toggle with restore, Sound settings open, clipboard fixture write/read, speech, notification, screenshot artifact, and Escape shortcut.
- Safety checks: brightness reports platform limitation when the CLI is unavailable; lock screen required confirmation and was not executed; original volume, mute, dark mode, and clipboard state were restored.

## S6 Mail, Calendar, Reminders, Notes, and Copy Drafts - Passed

Report: `docs/test-runs/simple-command-productivity/S6-productivity-report.json`

- Total scenarios: 11
- Passed: 11
- Failed: 0
- Realtime-2 connected: false
- Real execution: local email draft/search/read, local calendar create/search, local copy draft save/search, and macOS Reminders/Notes create-cleanup when automation is available.
- Safety checks: Mail draft, email send, macOS Calendar creation, and copy publish stopped at confirmation; local adapter data files were restored after the run.

## S7 Task, Confirmation, and Low-Risk Shell - Passed

Report: `docs/test-runs/simple-command-runtime/S7-task-confirmation-shell-report.json`

- Total scenarios: 8
- Passed: 8
- Failed: 0
- Realtime-2 connected: false
- Real execution: queued task list/status/cancel, confirmation list/reject/approve, approved bounded read-only shell, approved harmless folder creation, and dangerous shell validator failure.
- Safety checks: npm test and coding-agent start were confirmation-only and rejected; rejected confirmations produced no side effects; destructive shell did not remove the fixture folder.

## S8 Negative, Safety, and Clarification - Passed

Report: `docs/test-runs/simple-command-safety/S8-negative-safety-report.json`

- Total scenarios: 5
- Passed: 5
- Failed: 0
- Realtime-2 connected: false
- Real execution: generated negative intent cards, extracted a prompt-injection document as text, attempted and denied a credential-like file read, checked payment-submit confirmation, and validated rm -rf / blocking.
- Safety checks: no unsafe side effect occurred; secret fixture content was not written to the report.

## S9 Full Suite Report and Cleanup - Passed

Report: `docs/test-runs/simple-command-full-suite/S9-full-suite-report.md`

- Total scenarios/cards: 138
- Passed: 134
- Failed: 0
- Skipped: 1
- Unsupported: 0
- Blocked: 3
- Realtime-2 connected: false
- Cleanup checks: S3/S4 isolated Chrome profiles not running; screenshot PNGs ignored; report secret scan passed.
