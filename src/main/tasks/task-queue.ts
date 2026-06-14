import type { HerTask, HerTaskPriority } from "../../shared/tasks";
import { ResourceLockManager } from "./resource-lock-manager";
import { TaskStore } from "./task-store";

export type EnqueueTaskInput = {
  title: string;
  summary: string;
  toolName: string;
  arguments: Record<string, unknown>;
  priority?: HerTaskPriority;
  resourceLocks: string[];
  execute: (taskId: string) => Promise<unknown | AwaitingConfirmationResult>;
};

export type AwaitingConfirmationResult = {
  awaitingConfirmation: true;
  confirmationId: string;
  summary: string;
};

export class TaskQueue {
  private readonly locks = new ResourceLockManager();
  private executors = new Map<string, (taskId: string) => Promise<unknown>>();
  private processing = false;

  constructor(private store: TaskStore) {}

  enqueue(input: EnqueueTaskInput) {
    const task = this.store.create({
      kind: "exclusive",
      priority: input.priority ?? "normal",
      title: input.title,
      summary: input.summary,
      toolName: input.toolName,
      arguments: input.arguments,
      source: "realtime_tool_call",
      resourceLocks: input.resourceLocks,
    });
    this.executors.set(task.id, input.execute);
    void this.process();
    return task;
  }

  cancel(taskId: string, reason = "Cancelled by user.") {
    const task = this.store.require(taskId);
    if (task.status === "queued" || task.status === "blocked" || task.status === "awaiting_confirmation") {
      this.executors.delete(taskId);
      this.locks.releaseAll(taskId);
      void this.process();
      return { task: this.store.cancel(taskId, reason), cancelled: true };
    }
    if (task.status === "running") {
      this.store.update(taskId, {
        progress: { message: "Cancellation requested. This task will stop if the handler supports cancellation." },
      });
      this.store.appendEvent({ type: "task_progress", taskId, timestamp: new Date().toISOString(), message: "Cancellation requested." });
      return { task: this.store.get(taskId), cancelled: false, reason: "Running task cannot be force-cancelled by this handler." };
    }
    return { task: this.store.get(taskId), cancelled: false, reason: `Task is already ${task.status}.` };
  }

  lockManager() {
    return this.locks;
  }

  completeAwaitingConfirmation(taskId: string, result: unknown) {
    const task = this.store.update(taskId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      result,
    });
    this.store.appendEvent({ type: "task_completed", taskId, timestamp: new Date().toISOString(), result });
    this.locks.releaseAll(taskId);
    void this.process();
    return task;
  }

  failAwaitingConfirmation(taskId: string, error: Error | string) {
    const message = error instanceof Error ? error.message : String(error);
    const task = this.store.update(taskId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: { code: "task_failed", message, recoverable: false },
    });
    this.store.appendEvent({
      type: "task_failed",
      taskId,
      timestamp: new Date().toISOString(),
      error: { code: "task_failed", message, recoverable: false },
    });
    this.locks.releaseAll(taskId);
    void this.process();
    return task;
  }

  private async process() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (true) {
        const runnable = this.nextRunnableTasks();
        if (!runnable.length) return;
        for (const task of runnable) {
          this.start(task);
        }
        await Promise.resolve();
      }
    } finally {
      this.processing = false;
    }
  }

  private nextRunnableTasks() {
    const queued = this.store.list({ limit: 200 })
      .filter((task) => task.status === "queued" || task.status === "blocked")
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const runnable: HerTask[] = [];
    for (const task of queued) {
      if (!this.executors.has(task.id)) continue;
      if (!this.locks.canAcquire(task.id, task.resourceLocks)) {
        if (task.status !== "blocked") {
          this.store.update(task.id, { status: "blocked", progress: { message: "Waiting for resource lock." } });
        }
        continue;
      }
      this.locks.acquire(task.id, task.resourceLocks);
      runnable.push(task);
    }
    return runnable;
  }

  private start(task: HerTask) {
    const execute = this.executors.get(task.id);
    if (!execute) return;
    this.executors.delete(task.id);
    this.store.update(task.id, { status: "running", startedAt: new Date().toISOString() });
    this.store.appendEvent({ type: "task_progress", taskId: task.id, timestamp: new Date().toISOString(), message: "Task started." });
    void execute(task.id)
      .then((result) => {
        if (isAwaitingConfirmationResult(result)) {
          this.store.update(task.id, {
            status: "awaiting_confirmation",
            confirmationId: result.confirmationId,
            progress: { message: result.summary },
          });
          this.store.appendEvent({
            type: "task_confirmation_required",
            taskId: task.id,
            timestamp: new Date().toISOString(),
            confirmationId: result.confirmationId,
            summary: result.summary,
          });
          return;
        }
        this.store.update(task.id, {
          status: "completed",
          completedAt: new Date().toISOString(),
          result,
        });
        this.store.appendEvent({ type: "task_completed", taskId: task.id, timestamp: new Date().toISOString(), result });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.store.update(task.id, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: { code: "task_failed", message, recoverable: false },
        });
        this.store.appendEvent({
          type: "task_failed",
          taskId: task.id,
          timestamp: new Date().toISOString(),
          error: { code: "task_failed", message, recoverable: false },
        });
      })
      .finally(() => {
        const latest = this.store.get(task.id);
        if (latest?.status === "awaiting_confirmation") return;
        this.locks.releaseAll(task.id);
        void this.process();
      });
  }
}

const isAwaitingConfirmationResult = (value: unknown): value is AwaitingConfirmationResult =>
  Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as AwaitingConfirmationResult).awaitingConfirmation === true);

const priorityRank = (priority: HerTaskPriority) => {
  if (priority === "high") return 0;
  if (priority === "normal") return 1;
  return 2;
};
