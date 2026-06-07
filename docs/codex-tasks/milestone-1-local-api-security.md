# Milestone 1: Local API Security Boundary and Minimal Structure Split

## Goal

Harden Her's local API boundary and start reducing renderer/server coupling without changing product behavior.

## Scope

Implement only:

1. Local API token authentication.
2. Strict CORS / Origin checks.
3. A renderer local API client that automatically sends the token.
4. Minimal server route/auth split if needed.
5. Keep existing Realtime voice connection working.
6. Keep existing tool execution and confirmation behavior working.

## Out of scope

Do not implement:

- Tool Manifest refactor.
- Policy Engine refactor.
- Dynamic Realtime tool bundles.
- Codex coding-agent runtime.
- Electron Forge packaging.
- React rewrite.
- Full Renderer rewrite.

## Required implementation details

- Generate a high-entropy local API token at app startup.
- Sensitive APIs must require `Authorization: Bearer <localApiToken>`.
- Remove `Access-Control-Allow-Origin: *`.
- In dev, allow only:
  - `http://127.0.0.1:5174`
  - `http://localhost:5174`
- In production, do not allow arbitrary origins.
- `/health` may remain unauthenticated.
- These endpoints must require auth:
  - `/api/tools/execute`
  - `/api/tools/confirm`
  - `/api/tools/pending`
  - `/api/realtime/client-secret`
  - `/api/settings`
  - `/api/settings/capabilities`
  - `/api/settings/yolo`
  - `/api/apps/permissions`
  - `/api/system/settings`
- Do not log the token.
- Do not send the token to Realtime.
- Do not put the token in transcript or tool activity.
- Renderer API calls should go through one local client module.

## Suggested implementation path

1. Create `src/main/api/auth.ts`.
2. Create `src/main/api/cors.ts`.
3. Update local server to use auth middleware for sensitive routes.
4. Add a safe way for renderer to receive or use local API auth:
   - Prefer preload / IPC request wrapper.
   - If using a temporary dev-compatible token fetch, make sure it is only available to Her renderer and never logged.
5. Create `src/renderer/api/local-client.ts`.
6. Replace direct `fetch(`${LOCAL_API}${path}`)` calls with local-client helpers.
7. Keep current behavior otherwise unchanged.

## Acceptance criteria

- `npm run build` passes.
- Existing app still starts in dev mode.
- Existing Realtime voice connection still works.
- Existing tool calls still work from Her renderer.
- Calling `/api/tools/execute` without token returns 401.
- Calling `/api/tools/execute` with an invalid token returns 401.
- Calling sensitive APIs from a non-allowed Origin returns 403.
- Renderer API calls go through one local client module.
- No wildcard CORS remains for sensitive APIs.
- No token appears in logs, transcript, activity panel, or Realtime messages.

## Suggested files to inspect

- `src/main/server.ts`
- `src/main/main.ts`
- `src/renderer/main.ts`
- `src/main/realtime.ts`
- `src/shared/tools.ts`
- `src/main/config.ts`

## Completion report

After implementation, report:

- Changed files.
- Commands run.
- Build/test result.
- Remaining risks.
- Follow-up tasks.
