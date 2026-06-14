export type CodexJsonEvent = {
  type: string;
  message: string;
  raw: Record<string, unknown>;
};

export const parseCodexJsonLine = (line: string): CodexJsonEvent | undefined => {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { type: "unknown", message: trimmed, raw: { value: parsed as never } };
  }
  const raw = parsed as Record<string, unknown>;
  return {
    type: readString(raw, "type") ?? readString(raw, "event") ?? readString(raw, "kind") ?? "event",
    message: extractMessage(raw) ?? trimmed,
    raw,
  };
};

export const parseCodexJsonLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => {
      try {
        return parseCodexJsonLine(line);
      } catch {
        return undefined;
      }
    })
    .filter((event): event is CodexJsonEvent => Boolean(event));

const extractMessage = (value: Record<string, unknown>): string | undefined => {
  for (const key of ["message", "text", "content", "summary", "delta"]) {
    const direct = readString(value, key);
    if (direct) return direct;
  }
  const item = value.item;
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const nested = extractMessage(item as Record<string, unknown>);
    if (nested) return nested;
  }
  return undefined;
};

const readString = (value: Record<string, unknown>, key: string) => {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw : undefined;
};
