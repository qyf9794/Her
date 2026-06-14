export type ResourceLock = {
  taskId: string;
  resource: string;
  acquiredAt: string;
};

export class ResourceLockManager {
  private locks = new Map<string, ResourceLock>();

  canAcquire(taskId: string, resources: readonly string[]) {
    return resources.every((resource) => {
      const existing = this.locks.get(resource);
      return !existing || existing.taskId === taskId;
    });
  }

  acquire(taskId: string, resources: readonly string[]) {
    if (!this.canAcquire(taskId, resources)) {
      const blockedBy = resources
        .map((resource) => this.locks.get(resource))
        .find((lock) => lock && lock.taskId !== taskId);
      throw new Error(`Resource lock unavailable: ${blockedBy?.resource ?? resources[0]}`);
    }
    const acquiredAt = new Date().toISOString();
    for (const resource of resources) {
      this.locks.set(resource, { taskId, resource, acquiredAt });
    }
  }

  releaseAll(taskId: string) {
    for (const [resource, lock] of this.locks) {
      if (lock.taskId === taskId) this.locks.delete(resource);
    }
  }

  list() {
    return [...this.locks.values()];
  }
}
