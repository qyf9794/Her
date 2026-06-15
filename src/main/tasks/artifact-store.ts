import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HerArtifact, HerArtifactType } from "../../shared/artifacts";
import { redactTaskValue } from "./task-redaction";

type CreateArtifactInput = {
  type: HerArtifactType;
  title: string;
  summary: string;
  sourceTool?: string;
  sourceTaskId?: string;
  payload: unknown;
};

const maxArtifacts = 200;
const maxInlineChars = 12000;

export class ArtifactStore {
  private artifacts: HerArtifact[] = [];
  private readonly filePath?: string;

  constructor(userDataDir?: string) {
    this.filePath = userDataDir ? path.join(userDataDir, "her-artifacts.json") : undefined;
    this.load();
  }

  create(input: CreateArtifactInput) {
    const compacted = compactPayload(redactTaskValue(input.payload));
    const artifact: HerArtifact = {
      id: crypto.randomUUID(),
      type: input.type,
      title: input.title,
      summary: input.summary,
      sourceTool: input.sourceTool,
      sourceTaskId: input.sourceTaskId,
      createdAt: new Date().toISOString(),
      payload: compacted.payload,
      truncated: compacted.truncated,
      handle: compacted.truncated ? crypto.randomUUID() : undefined,
    };
    this.artifacts.unshift(artifact);
    this.artifacts = this.artifacts.slice(0, maxArtifacts);
    this.save();
    return artifact;
  }

  list(limit = 20) {
    return this.artifacts.slice(0, limit);
  }

  get(id: string) {
    return this.artifacts.find((artifact) => artifact.id === id);
  }

  private load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as { artifacts?: HerArtifact[] };
      this.artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts.slice(0, maxArtifacts) : [];
    } catch {
      this.artifacts = [];
    }
  }

  private save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify({ artifacts: this.artifacts }, null, 2));
  }
}

const compactPayload = (payload: unknown): { payload: unknown; truncated?: boolean } => {
  const serialized = safeStringify(payload);
  if (serialized.length <= maxInlineChars) return { payload };
  if (typeof payload === "string") {
    return { payload: `${payload.slice(0, maxInlineChars)}...`, truncated: true };
  }
  if (Array.isArray(payload)) {
    return { payload: payload.slice(0, 50), truncated: true };
  }
  if (payload && typeof payload === "object") {
    return {
      payload: {
        ...(payload as Record<string, unknown>),
        _truncated: true,
        _summary: serialized.slice(0, maxInlineChars),
      },
      truncated: true,
    };
  }
  return { payload: serialized.slice(0, maxInlineChars), truncated: true };
};

const safeStringify = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
