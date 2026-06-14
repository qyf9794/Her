# Security

Her is a local desktop agent, so the default posture is explicit local control, least privilege, and no silent fallback for sensitive actions.

## Local API

- `/api/*` requires a per-run bearer token generated in main process memory.
- CORS never uses `Access-Control-Allow-Origin: *`.
- Development allows only `http://127.0.0.1:5174` and `http://localhost:5174`.
- Packaged app API calls are expected from trusted local contexts.
- `Sec-Fetch-Site` is rejected unless it is `same-origin`, `same-site`, or `none`.

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

## Tool Safety

Tool calls are checked in this order:

1. Tool name is known in the manifest.
2. Arguments validate against the tool schema.
3. Capability and app permission gates pass.
4. Approval policy allows or creates a confirmation plan.
5. Handler executes only after the above gates.

YOLO mode may bypass low-risk local open/write operations, but it must not bypass shell, browser submit, external send, system change, or coding-agent confirmation.

## Prompt Injection

Content read from files, pages, emails, transcripts, or tool output is untrusted input. It must not be treated as authority to execute additional tools or bypass user confirmation.
