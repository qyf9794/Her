# HER Agent Configuration

## OpenAI Realtime-2 Requirements

HER's realtime voice layer must be configured according to the current official OpenAI Realtime and Voice Agents documentation. Treat the official OpenAI docs as the source of truth for model names, connection flow, session shape, events, tools, and migration requirements.

Reference docs:

- https://developers.openai.com/api/docs/models/gpt-realtime-2
- https://developers.openai.com/api/docs/guides/realtime
- https://developers.openai.com/api/docs/guides/voice-agents
- https://developers.openai.com/api/docs/guides/realtime-mcp

Required project rules:

- Use `gpt-realtime-2` for HER's primary low-latency speech-to-speech voice-agent session unless the user explicitly selects another supported realtime model.
- Start `gpt-realtime-2` with low reasoning effort for normal production voice-agent use, then raise it only when latency tolerance and task complexity justify the change.
- Use a voice-agent Realtime session for HER conversations where the model should respond, manage conversation state, and call tools. Do not use translation or transcription sessions as a substitute for the main HER assistant loop.
- Browser audio should use the official Realtime voice-agent flow with a server-created ephemeral client secret and a frontend `RealtimeSession` over WebRTC. Use WebSocket only for trusted server-side or media-pipeline flows.
- Keep transport concerns in the session layer. Keep HER business logic, tool routing, handoffs, guardrails, and intent behavior in the agent/router layer.
- Realtime-2 is responsible for conversational interaction and first-pass natural-language parsing into HER's StandardIntent JSON. It should call `intent_route` for normal user requests.
- HER Router decides whether a StandardIntent is handled by a direct HER tool or by Codex.
- Codex handles only complex intents. Codex must request any HER local side effect through HER Tool Gateway; it must not bypass HER permissions, app authorization, confirmation queue, task queue, or audit trail.
- Realtime tools must remain compact and stable during a live session. Use dynamic tool catalog routing and `task_create` for non-core tools instead of loading every local tool directly into the Realtime session.
- Side-effecting operations, including Calendar, Reminders, Notes, email send, file writes, shell, browser clicks/forms, shortcuts, phone calls, app/window control, and computer-use style actions, must go through HER-controlled tools and confirmation policy.
- Use official GA Realtime event/session shapes. Do not reintroduce beta-only headers or deprecated event names when modifying the Realtime integration.
- Include a stable privacy-preserving OpenAI safety identifier for Realtime requests when HER can identify the local user/session.
- When official OpenAI Realtime documentation changes, update this file and the corresponding implementation together.
