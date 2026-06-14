import type { RealtimeAgent, RealtimeSession } from "@openai/agents/realtime";
import { postJson, writeAudit } from "../api/local-client";
import type { ToolName } from "../../shared/tools";

export type RealtimeToolDefinition = {
  type: "function";
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
};

export type RealtimeBundleSelection = {
  bundles: string[];
  confidence: number;
  reason: string;
  shouldAskModelToSelect: boolean;
};

type RealtimeBundleSelectionResponse = {
  selection: RealtimeBundleSelection;
  tools: RealtimeToolDefinition[];
};

export class RealtimeSessionService {
  constructor(
    private readonly session: RealtimeSession,
    private readonly createAgent: (tools: readonly RealtimeToolDefinition[]) => RealtimeAgent,
  ) {}

  async respondToTranscript(transcript: string) {
    try {
      const response = await postJson<RealtimeBundleSelectionResponse>("/api/realtime/bundles/select", { transcript });
      await this.session.updateAgent(this.createAgent(response.tools));
      writeAudit("realtime.bundle", `Selected bundles: ${response.selection.bundles.join(", ")}`, "ok", {
        transcriptChars: transcript.length,
        selection: response.selection,
        toolCount: response.tools.length,
      });
    } catch (error) {
      writeAudit("realtime.bundle", errorMessage(error), "error", {
        transcriptChars: transcript.length,
      });
    }

    this.session.transport.requestResponse?.();
  }
}

const errorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};
