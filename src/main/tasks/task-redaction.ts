const secretKeyPattern = /(token|secret|cookie|authorization|credential|password|passwd|api[_-]?key|oauth|session|bearer|openai|realtime|local[_-]?api|npm[_-]?)/i;

export const redactTaskValue = (value: unknown, depth = 0): unknown => {
  if (depth > 5) return "[truncated]";
  if (typeof value === "string") return value.length > 800 ? `${value.slice(0, 800)}...` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null || typeof value === "undefined") return value;
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => redactTaskValue(item, depth + 1));
  if (typeof value !== "object") return String(value);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 50)
      .map(([key, nested]) => [
        key,
        secretKeyPattern.test(key) ? "[redacted]" : redactTaskValue(nested, depth + 1),
      ]),
  );
};
