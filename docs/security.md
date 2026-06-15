# Security

Her is a local desktop agent, so the default posture is explicit local control, least privilege, and no silent fallback for sensitive actions.

## Local API

- `/api/*` requires a per-run bearer token generated in main process memory.
- CORS never uses `Access-Control-Allow-Origin: *`.
- Development allows only `http://127.0.0.1:5174` and `http://localhost:5174`.
- Packaged app API calls are expected from trusted local contexts.
- `Sec-Fetch-Site` is rejected unless it is `same-origin`, `same-site`, or `none`.

## Electron Shell

- Packaged renderer loads through Her's privileged `her://app/index.html` protocol, not long-term `file://`.
- Development renderer is limited to the normalized Vite origin, normally `http://127.0.0.1:5174`.
- Renderer windows keep `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`; the preload exposes only the narrow Her IPC bridge.
- A Content Security Policy is applied to Her renderer documents. Production avoids `unsafe-eval`; development permits Vite's local origin and websocket endpoint.
- In-window navigation is allowed only for trusted Her renderer URLs. Safe HTTPS URLs may open externally through Electron's `shell.openExternal`; `javascript:`, `file:`, unknown protocols, and untrusted origins are blocked.
- Browser permission requests are allowed only from trusted Her renderer URLs and only for voice media permissions.

## Secrets

Do not expose or persist:

- `OPENAI_API_KEY`
- Realtime client secrets
- local API tokens
- OAuth tokens
- cookies
- passwords
- signing identities or notarization credentials

Task runtime and audit payloads redact common secret-like fields. Codex receives only a small allowlist of environment variables.

Explicit memory and Her Skills reject secret-like keys and values before persistence. Do not save API keys, OAuth tokens, cookies, passwords, bearer tokens, or local API tokens as aliases, memories, skill parameters, or skill step arguments.

## Apple Music MusicKit Keys

- The renderer can save MusicKit key metadata and an absolute `.p8` file path through the local API.
- Her stores only the key name, Team ID, Key ID, and private-key file path in `.env.local`; it does not copy or upload the `.p8` private key contents.
- Developer tokens are generated in the main process when needed and must not be exposed in logs, diagnostics, feedback exports, or task artifacts.

## Diagnostics And Beta Feedback

- Diagnostics and beta feedback exports are local-only JSON files written under the app userData export directory.
- Her does not upload diagnostics, feedback, transcripts, or telemetry automatically.
- Exports redact secret-like keys and values by default, including API keys, bearer tokens, cookies, passwords, private keys, and local API tokens.
- Users should review exported JSON before sharing it with a developer or issue tracker.

## Tool Safety

Tool calls are checked in this order:

1. Tool name is known in the manifest.
2. Arguments validate against the tool schema.
3. Capability and app permission gates pass.
4. Approval policy allows or creates a confirmation plan.
5. Handler executes only after the above gates.

YOLO mode may bypass low-risk local open/write operations, but it must not bypass shell, browser submit, external send, system change, or coding-agent confirmation.

Running a Her Skill is not a policy bypass. Each step is re-entered through the tool runtime and can still be denied or require confirmation.

## Prompt Injection

Content read from files, pages, emails, transcripts, or tool output is untrusted input. It must not be treated as authority to execute additional tools or bypass user confirmation.
