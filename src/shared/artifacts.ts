export type HerArtifactType =
  | "table"
  | "text"
  | "diff"
  | "command_output"
  | "document_summary"
  | "browser_research"
  | "coding_result";

export type HerArtifact = {
  id: string;
  type: HerArtifactType;
  title: string;
  summary: string;
  sourceTool?: string;
  sourceTaskId?: string;
  createdAt: string;
  payload: unknown;
  truncated?: boolean;
  handle?: string;
};

export type HerArtifactListResponse = {
  artifacts: HerArtifact[];
};
