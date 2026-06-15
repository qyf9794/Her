# Her Beta Smoke Checklist

Run this checklist on a local machine before sharing a beta build.

## Setup

- Start Her from a fresh userData directory or a clean test profile.
- Verify the Beta Setup panel is visible.
- Verify missing OpenAI key shows a setup path and keeps Start voice disabled.
- Save a test-format OpenAI key only in a local development profile if needed; never paste a real key into screenshots or logs.
- Choose a Realtime voice.
- Click Microphone Refresh or Start voice and verify macOS permission messaging is understandable.
- Review capability and app permissions, then enter the app.
- Refresh Codex login status and verify missing login explains how to start login.
- Refresh Workflow Packs and preview one pack before running it.

## Core Local Runtime

- Run `system_status` through the tool API or voice flow.
- Run a read-only file search inside an allowlisted folder.
- Trigger a high-risk local write and verify a confirmation appears.
- Reject the confirmation and verify no side effect happened.
- Approve a safe test confirmation and verify the task/activity panels update.

## Failure Recovery

- Missing OpenAI key: verify the API key panel gives a clear next step.
- Missing Codex login: verify coding tasks do not silently fall back to shell.
- Failed tool confirmation: verify the pending/task panel still shows enough context to retry or reject.
- Packaging failure: run `npm run package` and capture the terminal error without secrets.
- Realtime failure: verify the transcript shows a concise user-facing error.

## Local Privacy Export

- Click Export Diagnostics.
- Click Export Feedback with a fake secret-like string in the feedback note.
- Open both exported JSON files locally.
- Verify no API keys, bearer tokens, cookies, local API tokens, passwords, or full sensitive clipboard values are present.
- Share exports only after manual review.
