import type { ToolName } from "../../shared/tools";
import type { ActionPlan } from "../policy/approval-policy";

export type PendingConfirmation = {
  id: string;
  name: ToolName;
  summary: string;
  createdAt: number;
  expiresAt: number;
  plan: ActionPlan;
};

export class ConfirmationQueue {
  private pending = new Map<string, PendingConfirmation>();

  add(plan: ActionPlan) {
    const now = Date.parse(plan.createdAt);
    const expiresAt = Date.parse(plan.expiresAt);
    const confirmation: PendingConfirmation = {
      id: plan.id,
      name: plan.toolName,
      summary: plan.summary,
      createdAt: now,
      expiresAt,
      plan,
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
      return { rejected: true, summary: confirmation.summary, plan: confirmation.plan };
    }
    return { rejected: false, plan: confirmation.plan };
  }

  private prune() {
    const now = Date.now();
    for (const [id, item] of this.pending) {
      if (item.expiresAt <= now) this.pending.delete(id);
    }
  }
}
