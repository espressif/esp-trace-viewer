/**
 * Schedules redraw requests using a shared `requestAnimationFrame` loop.
 *
 * Panes register a draw callback implementing {@link Drawable} and call {@link RafScheduler.requestDraw}. Multiple redraw requests within a single animation frame coalesce into a single execution, repainting modified panes at most once per frame.
 */

/** Interface for components that repaint when the scheduler executes a frame. */
export interface Drawable {
  draw(): void;
}

type Raf = (cb: (t: number) => void) => number;
type Caf = (handle: number) => void;

export class RafScheduler {
  private readonly drawables = new Set<Drawable>();
  private readonly dirty = new Set<Drawable>();
  private allDirty = false;
  private handle: number | null = null;
  private readonly raf: Raf;
  private readonly caf: Caf;
  /** Resolvers waiting for scheduled frame execution to complete (see {@link whenIdle}). */
  private idleWaiters: Array<() => void> = [];

  constructor(raf?: Raf, caf?: Caf) {
    // Fall back to setTimeout when requestAnimationFrame is unavailable in test environments.
    const g = globalThis as unknown as { requestAnimationFrame?: Raf; cancelAnimationFrame?: Caf };
    this.raf = raf ?? g.requestAnimationFrame?.bind(globalThis) ?? ((cb) => setTimeout(() => cb(0), 16) as unknown as number);
    this.caf = caf ?? g.cancelAnimationFrame?.bind(globalThis) ?? ((h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>));
  }

  /** Registers a drawable target with the scheduler. */
  add(d: Drawable): void {
    this.drawables.add(d);
  }

  /** Unregisters a drawable target and clears any pending redraw request for it. */
  remove(d: Drawable): void {
    this.drawables.delete(d);
    this.dirty.delete(d);
  }

  /**
   * Marks a drawable target (or all registered targets when omitted) for redraw and schedules an animation frame.
   * Repeated calls within the same frame coalesce into a single execution.
   */
  requestDraw(d?: Drawable): void {
    if (d) this.dirty.add(d);
    else this.allDirty = true;
    if (this.handle === null) {
      this.handle = this.raf(() => this.flush());
    }
  }

  /** Returns true when no animation frame is currently scheduled. */
  get isIdle(): boolean {
    return this.handle === null;
  }

  /**
   * Resolves a promise when all scheduled frames finish executing.
   *
   * Resolves immediately when idle. When a frame is scheduled, resolves after the frame flushes without scheduling follow-up redraws.
   */
  whenIdle(): Promise<void> {
    if (this.handle === null) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Executes pending redraw requests during the animation frame callback. */
  private flush(): void {
    this.handle = null;
    const targets = this.allDirty ? this.drawables : this.dirty;
    const toDraw = [...targets];
    this.dirty.clear();
    this.allDirty = false;
    for (const d of toDraw) d.draw();
    // Notify idle waiters only when no subsequent frame was scheduled during flush.
    if (this.handle === null && this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  /** Cancels any scheduled animation frame and clears pending redraw requests. */
  cancel(): void {
    if (this.handle !== null) {
      this.caf(this.handle);
      this.handle = null;
    }
    this.dirty.clear();
    this.allDirty = false;
    if (this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}
