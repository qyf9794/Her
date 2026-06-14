import { config, readOpenaiApiKey } from "./config";
import { buildRealtimeAgentInstructions } from "../shared/realtime-agent";
import { createRealtimeClientSecretSession } from "../shared/realtime-config";

const realtimeRuntimeOptions = () => ({
  budget: {
    postInstructions: config.realtimePostInstructionsTokens,
    retentionRatio: config.realtimeRetentionRatio,
  },
  maxOutputTokens: config.realtimeMaxOutputTokens,
  transcriptionEnabled: config.realtimeTranscriptionEnabled,
  transcriptionModel: config.realtimeTranscriptionModel,
  turnDetection: {
    threshold: config.realtimeVadThreshold,
    silenceDurationMs: config.realtimeVadSilenceDurationMs,
    prefixPaddingMs: config.realtimeVadPrefixPaddingMs,
  },
});

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
      session: createRealtimeClientSecretSession({
        model: config.realtimeModel,
        voice: config.realtimeVoice,
        instructions: buildRealtimeAgentInstructions(),
        options: realtimeRuntimeOptions(),
      }),
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
      realtimeMode: config.realtimeMode,
      realtimeEconomyModel: config.realtimeEconomyModel,
      realtimeVoice: config.realtimeVoice,
      truncation: {
        postInstructions: config.realtimePostInstructionsTokens,
        retentionRatio: config.realtimeRetentionRatio,
      },
      maxOutputTokens: config.realtimeMaxOutputTokens,
      transcription: {
        enabled: config.realtimeTranscriptionEnabled,
        model: config.realtimeTranscriptionModel,
      },
      turnDetection: {
        threshold: config.realtimeVadThreshold,
        silenceDurationMs: config.realtimeVadSilenceDurationMs,
        prefixPaddingMs: config.realtimeVadPrefixPaddingMs,
      },
    },
  };
};
