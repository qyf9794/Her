export type AliasTarget = {
  toolName: string;
  arguments: Record<string, unknown>;
};

export type AliasDefinition = {
  id: string;
  phrase: string;
  normalizedPhrase: string;
  description?: string;
  target: AliasTarget;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  runCount: number;
};

export type AliasCreateInput = {
  phrase: string;
  target: AliasTarget;
  description?: string;
  overwrite?: boolean;
};

export type AliasUpdateInput = {
  aliasId?: string;
  phrase?: string;
  nextPhrase?: string;
  target?: AliasTarget;
  description?: string;
  enabled?: boolean;
};

export type AliasResolution =
  | {
      matched: true;
      alias: AliasDefinition;
      confidence: number;
      reason: string;
    }
  | {
      matched: false;
      confidence: number;
      reason: string;
    };
