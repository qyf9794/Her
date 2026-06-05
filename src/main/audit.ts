import fs from "node:fs";
import path from "node:path";
import type { AuditEvent } from "../shared/events";

const auditPath = path.join(process.cwd(), "data", "audit.jsonl");

export class AuditLog {
  private listeners = new Set<(event: AuditEvent) => void>();

  write(event: Omit<AuditEvent, "id" | "timestamp">) {
    const entry: AuditEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...compactAuditEvent(event),
    };
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, "utf8");
    for (const listener of this.listeners) listener(entry);
    return entry;
  }

  onEvent(listener: (event: AuditEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const AUDIT_DETAILS_INLINE_LIMIT = 5000;

const compactAuditEvent = (event: Omit<AuditEvent, "id" | "timestamp">): Omit<AuditEvent, "id" | "timestamp"> => {
  if (!event.details) return event;
  const compacted = compactValue(event.details);
  return {
    ...event,
    details: compacted && typeof compacted === "object" && !Array.isArray(compacted) ? (compacted as Record<string, unknown>) : { value: compacted },
  };
};

const compactValue = (value: unknown): unknown => {
  if (typeof value === "string") return value.length > AUDIT_DETAILS_INLINE_LIMIT ? `${value.slice(0, AUDIT_DETAILS_INLINE_LIMIT)}...` : value;
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(compactValue);

  const entries = Object.entries(value as Record<string, unknown>).slice(0, 80);
  return Object.fromEntries(
    entries.map(([key, item]) => {
      if (/api[_-]?key|secret|token|authorization|password/i.test(key)) return [key, "[redacted]"];
      return [key, compactValue(item)];
    }),
  );
};
