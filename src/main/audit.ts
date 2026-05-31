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
      ...event,
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
