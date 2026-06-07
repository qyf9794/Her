export const realtimeInputTokenBudget = {
  postInstructions: 6000,
  retentionRatio: 0.8,
} as const;

export type RealtimeInputTokenBudget = {
  postInstructions: number;
  retentionRatio: number;
};

export type RealtimeTurnDetectionTuning = {
  threshold: number;
  silenceDurationMs: number;
  prefixPaddingMs: number;
};

export type RealtimeRuntimeOptions = {
  budget?: RealtimeInputTokenBudget;
  maxOutputTokens?: number;
  transcriptionEnabled?: boolean;
  transcriptionModel?: string;
  turnDetection?: RealtimeTurnDetectionTuning;
};

export const realtimeTranscriptionModel = "gpt-4o-mini-transcribe";
export const realtimeMaxOutputTokens = 1200;
export const realtimeDefaultVoice = "marin";
export const realtimeVoiceOptions = [
  { value: "marin", label: "Marin", recommended: true },
  { value: "cedar", label: "Cedar", recommended: true },
  { value: "alloy", label: "Alloy" },
  { value: "ash", label: "Ash" },
  { value: "ballad", label: "Ballad" },
  { value: "coral", label: "Coral" },
  { value: "echo", label: "Echo" },
  { value: "sage", label: "Sage" },
  { value: "shimmer", label: "Shimmer" },
  { value: "verse", label: "Verse" },
] as const;
export type RealtimeVoice = (typeof realtimeVoiceOptions)[number]["value"];
export const isRealtimeVoice = (value: string): value is RealtimeVoice =>
  realtimeVoiceOptions.some((option) => option.value === value);
export const realtimeTurnDetectionTuning = {
  threshold: 0.55,
  silenceDurationMs: 700,
  prefixPaddingMs: 300,
} as const;

const resolvedBudget = (options?: RealtimeRuntimeOptions) => options?.budget ?? realtimeInputTokenBudget;
const resolvedMaxOutputTokens = (options?: RealtimeRuntimeOptions) => options?.maxOutputTokens ?? realtimeMaxOutputTokens;
const resolvedTranscriptionModel = (options?: RealtimeRuntimeOptions) => options?.transcriptionModel ?? realtimeTranscriptionModel;
const resolvedTurnDetection = (options?: RealtimeRuntimeOptions) => options?.turnDetection ?? realtimeTurnDetectionTuning;

export const createRealtimeTruncationProviderConfig = (budget: RealtimeInputTokenBudget = realtimeInputTokenBudget) => ({
  truncation: {
    type: "retention_ratio",
    retention_ratio: budget.retentionRatio,
    token_limits: {
      post_instructions: budget.postInstructions,
    },
  },
});

export const realtimeTruncationProviderConfig = createRealtimeTruncationProviderConfig();

export const createRealtimeProviderConfig = (options?: RealtimeRuntimeOptions) => ({
  ...createRealtimeTruncationProviderConfig(resolvedBudget(options)),
  max_output_tokens: resolvedMaxOutputTokens(options),
});

const createRealtimeTurnDetectionConfig = (options?: RealtimeRuntimeOptions) => {
  const turnDetection = resolvedTurnDetection(options);
  return {
    type: "server_vad",
    createResponse: true,
    interruptResponse: true,
    threshold: turnDetection.threshold,
    silenceDurationMs: turnDetection.silenceDurationMs,
    prefixPaddingMs: turnDetection.prefixPaddingMs,
  };
};

const createRealtimeTurnDetectionApiConfig = (options?: RealtimeRuntimeOptions) => {
  const turnDetection = resolvedTurnDetection(options);
  return {
    type: "server_vad",
    create_response: true,
    interrupt_response: true,
    threshold: turnDetection.threshold,
    silence_duration_ms: turnDetection.silenceDurationMs,
    prefix_padding_ms: turnDetection.prefixPaddingMs,
  };
};

const createRealtimeTranscriptionConfig = (options?: RealtimeRuntimeOptions) => {
  if (options?.transcriptionEnabled === false) return null;
  return { model: resolvedTranscriptionModel(options) };
};

export const createRealtimeSessionConfig = (
  voice: string,
  options?: RealtimeRuntimeOptions,
) =>
  ({
    outputModalities: ["audio"],
    audio: {
      output: {
        voice,
      },
      input: {
        transcription: createRealtimeTranscriptionConfig(options),
        turnDetection: createRealtimeTurnDetectionConfig(options),
      },
    },
    toolChoice: "auto",
    parallelToolCalls: false,
    providerData: createRealtimeProviderConfig(options),
  }) as const;

export const createRealtimeClientSecretSession = (input: {
  model: string;
  voice: string;
  instructions: string;
  options?: RealtimeRuntimeOptions;
}) => ({
  type: "realtime",
  model: input.model,
  instructions: input.instructions,
  output_modalities: ["audio"],
  audio: {
    output: {
      voice: input.voice,
    },
    input: {
      transcription: createRealtimeTranscriptionConfig(input.options),
      turn_detection: createRealtimeTurnDetectionApiConfig(input.options),
    },
  },
  tool_choice: "auto",
  parallel_tool_calls: false,
  ...createRealtimeProviderConfig(input.options),
});
