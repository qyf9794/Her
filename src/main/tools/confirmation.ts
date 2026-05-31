import type { ToolName } from "../../shared/tools";

export type PendingConfirmation = {
  id: string;
  name: ToolName;
  summary: string;
  createdAt: number;
  expiresAt: number;
  run: () => Promise<unknown>;
};

export class ConfirmationQueue {
  private pending = new Map<string, PendingConfirmation>();

  add(input: Omit<PendingConfirmation, "id" | "createdAt" | "expiresAt">) {
    const now = Date.now();
    const confirmation: PendingConfirmation = {
      id: crypto.randomUUID(),
      createdAt: now,
      expiresAt: now + 5 * 60 * 1000,
      ...input,
    };
    this.pending.set(confirmation.id, confirmation);
    return confirmation;
  }

  list() {
    this.prune();
    return [...this.pending.values()];
  }

  async decide(id: string, approved: boolean) {
    this.prune();
    const confirmation = this.pending.get(id);
    if (!confirmation) throw new Error("Confirmation request not found or expired.");
    this.pending.delete(id);
    if (!approved) {
      return { rejected: true, summary: confirmation.summary };
    }
    const result = await confirmation.run();
    return { rejected: false, result };
  }

  private prune() {
    const now = Date.now();
    for (const [id, item] of this.pending) {
      if (item.expiresAt <= now) this.pending.delete(id);
    }
  }
}
