import crypto from "node:crypto";
import type {
  CodingAgentEvent,
  CodingAgentMode,
  CodingAgentSandbox,
  CodingAgentStatus,
  CodingAgentTask,
  CodingAgentTaskView,
} from "../../../shared/agents/coding-agent";

export class CodingAgentTaskStore {
  private tasks = new Map<string, CodingAgentTask>();
  private events = new Map<string, CodingAgentEvent[]>();
  private order: string[] = [];

  create(input: {
    prompt: string;
    mode: CodingAgentMode;
    repoPath: string;
    sandbox: CodingAgentSandbox;
  }) {
    const now = new Date().toISOString();
    const task: CodingAgentTask = {
      id: crypto.randomUUID(),
      prompt: input.prompt,
      mode: input.mode,
      status: "queued",
      repoPath: input.repoPath,
      sandbox: input.sandbox,
      approvalPolicy: "on-request",
      createdAt: now,
      updatedAt: now,
      eventCount: 0,
    };
    this.tasks.set(task.id, task);
    this.events.set(task.id, []);
    this.order.unshift(task.id);
    return this.view(task.id);
  }

  get(taskId: string) {
    const task = this.tasks.get(taskId);
    return task ? this.view(taskId) : undefined;
  }

  list(limit = 20, status?: CodingAgentStatus) {
    return this.order
      .map((id) => this.tasks.get(id))
      .filter((task): task is CodingAgentTask => Boolean(task))
      .filter((task) => !status || task.status === status)
      .slice(0, limit)
      .map((task) => this.view(task.id));
  }

  update(taskId: string, patch: Partial<CodingAgentTask>) {
    const task = this.require(taskId);
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    return this.view(taskId);
  }

  addEvent(taskId: string, input: Omit<CodingAgentEvent, "id" | "taskId" | "at">) {
    const task = this.require(taskId);
    const event: CodingAgentEvent = {
      id: crypto.randomUUID(),
      taskId,
      at: new Date().toISOString(),
      ...input,
    };
    const events = this.events.get(taskId) ?? [];
    events.push(event);
    if (events.length > 200) events.splice(0, events.length - 200);
    this.events.set(taskId, events);
    task.eventCount += 1;
    task.updatedAt = event.at;
    return event;
  }

  require(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Coding agent task not found: ${taskId}`);
    return task;
  }

  private view(taskId: string): CodingAgentTaskView {
    const task = this.require(taskId);
    return {
      ...task,
      events: [...(this.events.get(taskId) ?? [])],
    };
  }
}
