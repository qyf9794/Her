import { config, readOpenaiApiKey } from "./config";
import { realtimeAgentInstructions } from "../shared/realtime-agent";

export const createRealtimeClientSecret = async (safetyIdentifier?: string) => {
  const apiKey = readOpenaiApiKey();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(safetyIdentifier ? { "OpenAI-Safety-Identifier": safetyIdentifier } : {}),
    },
    body: JSON.stringify({
      expires_after: {
        anchor: "created_at",
        seconds: 600,
      },
      session: {
        type: "realtime",
        model: config.realtimeModel,
        instructions: realtimeAgentInstructions,
        output_modalities: ["audio"],
        audio: {
          output: {
            voice: config.realtimeVoice,
          },
          input: {
            transcription: {
              model: "gpt-4o-mini-transcribe",
            },
            turn_detection: {
              type: "server_vad",
              create_response: true,
              interrupt_response: true,
            },
          },
        },
      },
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof payload.error === "object" && payload.error && "message" in payload.error
        ? String((payload.error as { message: unknown }).message)
        : `OpenAI Realtime client secret request failed with ${response.status}`;
    throw new Error(message);
  }

  return {
    ...payload,
    her: {
      realtimeModel: config.realtimeModel,
      realtimeVoice: config.realtimeVoice,
    },
  };
};
