import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  HerTask,
  HerTaskEvent,
  HerTaskKind,
  HerTaskPriority,
  HerTaskSource,
  HerTaskStatus,
  HerTaskView,
} from "../../shared/tasks";
import { redactTaskValue } from "./task-redaction";

type PersistedTasks = {
  tasks: HerTask[];
  events: Record<string, HerTaskEvent[]>;
};

export type CreateTaskInput = {
  kind: HerTaskKind;
  priority?: HerTaskPriority;
  title: string;
  summary: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  source?: HerTaskSource;
  resourceLocks?: string[];
  parentTaskId?: string;
};

export class TaskStore {
  private tasks = new Map<string, HerTask>();
  private events = new Map<string, HerTaskEvent[]>();
  private order: string[] = [];
  private readonly maxTasks = 200;
  private readonly filePath?: string;

  constructor(userDataDir?: string) {
    this.filePath = userDataDir ? path.join(userDataDir, "her-tasks.json") : undefined;
    this.load();
  }

  create(input: CreateTaskInput) {
    const now = new Date().toISOString();
    const task: HerTask = {
      id: crypto.randomUUID(),
      kind: input.kind,
      status: "queued",
      priority: input.priority ?? "normal",
      title: input.title,
      summary: input.summary,
      toolName: input.toolName,
      arguments: redactTaskValue(input.arguments ?? {}) as Record<string, unknown>,
      source: input.source ?? "manual",
      resourceLocks: input.resourceLocks ?? [],
      parentTaskId: input.parentTaskId,
      childTaskIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    this.events.set(task.id, []);
    this.order.unshift(task.id);
    this.appendEvent({ type: "task_created", taskId: task.id, timestamp: now, task });
    this.prune();
    this.save();
    return this.view(task.id);
  }

  update(taskId: string, patch: Partial<HerTask>) {
    const task = this.require(taskId);
    const previous = task.status;
    Object.assign(task, redactTaskPatch(patch), { updatedAt: new Date().toISOString() });
    if (patch.status && patch.status !== previous) {
      this.appendEvent({
        type: "task_status_changed",
        taskId,
        timestamp: task.updatedAt,
        from: previous,
        to: patch.status,
      });
    }
    this.save();
    return this.view(taskId);
  }

  get(taskId: string) {
    return this.tasks.has(taskId) ? this.view(taskId) : undefined;
  }

  list(filter: { status?: HerTaskStatus; limit?: number } = {}) {
    const limit = filter.limit ?? 20;
    return this.order
      .map((id) => this.tasks.get(id))
      .filter((task): task is HerTask => Boolean(task))
      .filter((task) => !filter.status || task.status === filter.status)
      .slice(0, limit)
      .map((task) => this.view(task.id));
  }

  appendEvent(event: HerTaskEvent) {
    const events = this.events.get(event.taskId) ?? [];
    events.push(redactTaskValue(event) as HerTaskEvent);
    if (events.length > 200) events.splice(0, events.length - 200);
    this.events.set(event.taskId, events);
    this.save();
  }

  listEvents(taskId: string, limit = 50) {
    return [...(this.events.get(taskId) ?? [])].slice(-limit);
  }

  cancel(taskId: string, reason = "Cancelled by user.") {
    const now = new Date().toISOString();
    const task = this.require(taskId);
    task.status = "cancelled";
    task.completedAt = now;
    task.updatedAt = now;
    task.error = { code: "cancelled", message: reason, recoverable: false };
    this.appendEvent({ type: "task_cancelled", taskId, timestamp: now, reason });
    this.save();
    return this.view(taskId);
  }

  require(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  private view(taskId: string): HerTaskView {
    const task = this.require(taskId);
    return { ...task, events: this.listEvents(taskId) };
  }

  private prune() {
    const extra = this.order.slice(this.maxTasks);
    this.order = this.order.slice(0, this.maxTasks);
    for (const id of extra) {
      this.tasks.delete(id);
      this.events.delete(id);
    }
  }

  private load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as PersistedTasks;
      for (const task of parsed.tasks ?? []) {
        this.tasks.set(task.id, task);
        this.order.push(task.id);
      }
      for (const [taskId, events] of Object.entries(parsed.events ?? {})) {
        this.events.set(taskId, events);
      }
    } catch {
      this.tasks.clear();
      this.events.clear();
      this.order = [];
    }
  }

  private save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: PersistedTasks = {
      tasks: this.order.map((id) => this.tasks.get(id)).filter((task): task is HerTask => Boolean(task)),
      events: Object.fromEntries(this.events),
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2));
  }
}

const redactTaskPatch = (patch: Partial<HerTask>): Partial<HerTask> => {
  const redacted = { ...patch };
  if (Object.prototype.hasOwnProperty.call(patch, "arguments")) {
    redacted.arguments = patch.arguments ? (redactTaskValue(patch.arguments) as Record<string, unknown>) : patch.arguments;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "result")) {
    redacted.result = patch.result ? redactTaskValue(patch.result) : patch.result;
  }
  return redacted;
};
