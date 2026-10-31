import type { Snapshot } from "./model"

export interface UsageView {
  snapshot: Snapshot | undefined
  busy: boolean
  offline: boolean
}

/** One per desktop window, shared by every mounted chat header. Views do not own requests or data. */
export class SharedUsage {
  readonly state: UsageView
  private pending: Promise<void> | undefined
  private disposed = false

  constructor(
    private read: (refresh: boolean) => Promise<Snapshot>,
    initial: Snapshot | undefined,
    private changed: (state: UsageView) => void,
  ) {
    this.state = { snapshot: initial, busy: false, offline: false }
  }

  refresh(force = false): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.pending) return this.pending
    this.state.busy = true
    this.changed({ ...this.state })
    const task = this.load(force)
    this.pending = task
    return task.finally(() => {
      if (this.pending === task) this.pending = undefined
    })
  }

  dispose() {
    this.disposed = true
  }

  private async load(force: boolean) {
    try {
      const snapshot = await this.read(force)
      if (this.disposed) return
      this.state.snapshot = snapshot
      this.state.offline = false
    } catch {
      if (!this.disposed) this.state.offline = true
    } finally {
      if (!this.disposed) {
        this.state.busy = false
        this.changed({ ...this.state })
      }
    }
  }
}
