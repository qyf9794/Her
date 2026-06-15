# Milestone 9: Electron Production Security and Distribution

## Goal

Prepare Her for real local installation and distribution without weakening the local runtime boundary.

## Scope

1. Replace long-term production `file://` renderer loading with a Her-owned custom protocol.
2. Add strict Content Security Policy for production and a dev-compatible policy for Vite.
3. Restrict renderer navigation and new-window handling:
   - allow only trusted Her renderer URLs in-window
   - open safe external HTTPS URLs through `shell.openExternal`
   - block `javascript:`, `file:`, unknown protocols, and untrusted origins
4. Harden permission requests so only the trusted Her renderer can request sensitive permissions.
5. Add signing/notarization placeholders without hardcoded secrets.
6. Improve the auto-update channel skeleton without requiring a real update server.
7. Add automated coverage for protocol/CSP/navigation/external URL/permission policy.

## Out of Scope

- Do not implement M10 beta diagnostics or onboarding work.
- Do not require real signing certificates, notarization credentials, or update provider secrets.
- Do not weaken local API auth, CORS, or confirmation policy.

## Automatic Acceptance

- `npm run typecheck` passes.
- `npm run test` passes.
- `npm run build` passes.
- `npm run check` passes.
- Renderer has no Node access.
- `window.require`, `process`, and `Buffer` are unavailable.
- Non-Her navigation is blocked.
- External open allows only safe HTTPS URLs.
- `javascript:`, `file:`, and unknown protocols are blocked.
- Packaged renderer uses custom protocol instead of long-term `file://`.
- Local API auth still works.
- No signing, notarization, local API, OpenAI, OAuth, or update secrets are hardcoded.

## Scenario Tests

1. Production renderer URL resolves to `her://app/index.html`.
2. Dev renderer URL remains `http://127.0.0.1:5174`.
3. Attempt `javascript:` navigation and verify it is blocked.
4. Attempt `file:` navigation and verify it is blocked.
5. Attempt arbitrary HTTPS in-window navigation and verify it opens externally only when safe.
6. Try local API from an arbitrary web origin and verify 401/403 behavior is unchanged.
7. Verify microphone permission requests are only allowed from a trusted Her renderer URL.

## Exit Criteria

Her can move toward trusted local distribution with Electron renderer, navigation, and packaging boundaries tightened.
