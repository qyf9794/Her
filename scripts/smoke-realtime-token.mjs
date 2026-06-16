import dotenv from "dotenv";
import crypto from "node:crypto";
import { ProxyAgent, fetch as undiciFetch } from "undici";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const apiKey = process.env.OPENAI_API_KEY;
const openaiProxyUrl = process.env.HER_OPENAI_PROXY_URL?.trim() ?? "";
const model = process.env.HER_REALTIME_MODEL ?? "gpt-realtime-2";
const voice = process.env.HER_REALTIME_VOICE ?? "marin";
const postInstructions = Number(process.env.HER_REALTIME_POST_INSTRUCTIONS_TOKENS ?? "6000");
const retentionRatio = Number(process.env.HER_REALTIME_RETENTION_RATIO ?? "0.8");
const maxOutputTokens = Number(process.env.HER_REALTIME_MAX_OUTPUT_TOKENS ?? "1200");
const transcriptionEnabled = !/^(0|false|no|off)$/i.test(process.env.HER_REALTIME_TRANSCRIPTION_ENABLED ?? "true");
const transcriptionModel = process.env.HER_REALTIME_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe";
const vadThreshold = Number(process.env.HER_REALTIME_VAD_THRESHOLD ?? "0.55");
const vadSilenceDurationMs = Number(process.env.HER_REALTIME_VAD_SILENCE_DURATION_MS ?? "700");
const vadPrefixPaddingMs = Number(process.env.HER_REALTIME_VAD_PREFIX_PADDING_MS ?? "300");
const safetyIdentifier = crypto.createHash("sha256").update(`her-smoke:${process.cwd()}`).digest("hex");

if (!apiKey) {
  console.error("OPENAI_API_KEY is not configured.");
  process.exit(1);
}

const response = await fetchOpenai("https://api.openai.com/v1/realtime/client_secrets", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "OpenAI-Safety-Identifier": safetyIdentifier,
  },
  body: JSON.stringify({
    expires_after: { anchor: "created_at", seconds: 60 },
    session: {
      type: "realtime",
      model,
      instructions: "Say hello in Chinese.",
      output_modalities: ["audio"],
      audio: {
        output: { voice },
        input: {
          transcription: transcriptionEnabled ? { model: transcriptionModel } : null,
          turn_detection: {
            type: "server_vad",
            create_response: false,
            interrupt_response: true,
            threshold: vadThreshold,
            silence_duration_ms: vadSilenceDurationMs,
            prefix_padding_ms: vadPrefixPaddingMs,
          },
        },
      },
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_output_tokens: maxOutputTokens,
      truncation: {
        type: "retention_ratio",
        retention_ratio: retentionRatio,
        token_limits: {
          post_instructions: postInstructions,
        },
      },
    },
  }),
});

const payload = await response.json().catch(() => ({}));

if (!response.ok) {
  const message = payload?.error?.message ?? `HTTP ${response.status}`;
  console.error(`Realtime smoke test failed: ${message}`);
  process.exit(1);
}

const hasSecret = Boolean(payload?.value || payload?.client_secret?.value);
console.log(JSON.stringify({
  ok: true,
  model,
  voice,
  post_instructions: postInstructions,
  retention_ratio: retentionRatio,
  max_output_tokens: maxOutputTokens,
  transcription_enabled: transcriptionEnabled,
  vad_threshold: vadThreshold,
  has_client_secret: hasSecret,
}));

function fetchOpenai(url, init) {
  if (!openaiProxyUrl) return fetch(url, init);
  return undiciFetch(url, {
    ...init,
    dispatcher: new ProxyAgent(openaiProxyUrl),
  });
}
