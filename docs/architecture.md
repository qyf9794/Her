# Architecture

Her is an Electron desktop app with a local agent runtime. The security boundary lives in the Electron main process and the local API server, not in the renderer.

## Runtime Layers

- Renderer: voice UI, transcript, confirmation UI, mini player, task panels, and local API bridge calls.
- Electron main: window lifecycle, preload bridge, local API server startup, and packaged app integration.
- Local API: authenticated loopback HTTP API used by the trusted renderer.
- Tool runtime: manifest-defined tools, schema validation, capability checks, approval policy, confirmation queue, task runtime, and audit log.
- Realtime runtime: client-secret creation, dynamic tool bundle selection, and Realtime tool definitions generated from the manifest.
- Codex runtime: asynchronous coding-agent tasks running in isolated git worktrees.

## Trust Boundaries

- Renderer never receives `OPENAI_API_KEY`, Realtime secrets, local API token, OAuth tokens, cookies, or signing credentials.
- External web pages cannot call `/api/*`; requests require trusted origin checks plus bearer auth.
- Tool execution happens only through the main-process registry.
- High-risk tools must pass approval policy before side effects.
- Codex child processes receive a sanitized environment and do not inherit full `process.env`.

## Build Outputs

- Main/shared TypeScript compiles to `electron/dist`.
- Renderer builds to `dist/renderer`.
- Electron Forge packages both outputs into the app bundle.
