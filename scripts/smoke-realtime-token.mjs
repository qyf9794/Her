import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.HER_REALTIME_MODEL ?? "gpt-realtime-2";
const voice = process.env.HER_REALTIME_VOICE ?? "marin";

if (!apiKey) {
  console.error("OPENAI_API_KEY is not configured.");
  process.exit(1);
}

const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    expires_after: { anchor: "created_at", seconds: 60 },
    session: {
      type: "realtime",
      model,
      instructions: "Say hello in Chinese.",
      output_modalities: ["audio"],
      audio: { output: { voice } },
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
console.log(JSON.stringify({ ok: true, model, voice, has_client_secret: hasSecret }));
