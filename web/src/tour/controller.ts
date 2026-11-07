import { FALLBACK_AGENT_ID, TOUR_STEPS, routeForStep } from './steps';
import type { TourStepDef } from './steps';

/*
 * Tour orchestration, separated from both React and Driver.js.
 *
 * Driver.js owns the overlay, popover and keyboard handling; this class owns
 * everything Driver.js cannot know: which route a step lives on, which real
 * agent id to substitute into agent-scoped routes, when a navigation was ours
 * versus the user leaving, and what to persist when the tour ends. The
 * boundary is the small `TourDriverHandle`/`TourDriverHandlers` pair, which is
 * also what makes this file testable without a DOM.
 */

export type TourEndReason = 'completed' | 'dismissed';

/** The slice of a Driver.js instance the controller drives. */
export interface TourDriverHandle {
  drive(index?: number): void;
  moveTo(index: number): void;
  destroy(): void;
  isActive(): boolean;
  getActiveIndex(): number | undefined;
}

/** Callbacks the Driver.js config must route back into the controller. */
export interface TourDriverHandlers {
  onNext(): void;
  onPrev(): void;
  /** Driver.js destroy reason: 'done', 'close', 'escape', 'overlay', 'api'… */
  onDestroyed(reason: string | undefined): void;
  onRestart(): void;
}

export interface TourControllerDeps {
  navigate(path: string): void;
  currentPath(): string;
  /** A real agent id visible in the current page, or null if none is. */
  findAgentId(): string | null;
  createDriver(handlers: TourDriverHandlers): TourDriverHandle;
  persist(result: TourEndReason): void;
  onActiveChange?(active: boolean): void;
}

export class TourController {
  private readonly steps: readonly TourStepDef[];
  private driver: TourDriverHandle | null = null;
  private agentId = FALLBACK_AGENT_ID;
  /** A path we navigated to ourselves; seeing it arrive is not an exit. */
  private pendingPath: string | null = null;
  /** Set when the controller itself ends the tour, so the destroy callback
   *  knows this was a completion rather than a dismissal. */
  private finishReason: TourEndReason | null = null;
  /** True only while dispose() tears the driver down, so an unmount does not
   *  record a verdict the user never gave. */
  private disposing = false;

  constructor(
    private readonly deps: TourControllerDeps,
    steps: readonly TourStepDef[] = TOUR_STEPS,
  ) {
    this.steps = steps;
  }

  isActive(): boolean {
    return this.driver?.isActive() ?? false;
  }

  /** Start from the beginning; restarts in place if already running. */
  start(): void {
    if (this.driver !== null && this.driver.isActive()) {
      this.goTo(0);
      return;
    }
    this.pendingPath = null;
    this.finishReason = null;
    this.agentId = FALLBACK_AGENT_ID;
    this.driver ??= this.deps.createDriver({
      onNext: () => this.next(),
      onPrev: () => this.prev(),
      onDestroyed: (reason) => this.handleDestroyed(reason),
      onRestart: () => this.goTo(0),
    });
    const first = this.steps[0];
    if (first !== undefined) this.ensureRoute(first);
    // Driver.js waits for the step's element, so driving immediately after a
    // navigation is safe: the popover appears once the new page has rendered.
    this.driver.drive(0);
    this.deps.onActiveChange?.(true);
  }

  private next(): void {
    const index = this.driver?.getActiveIndex();
    if (index === undefined) return;
    if (index >= this.steps.length - 1) {
      this.finishReason = 'completed';
      this.driver?.destroy();
      return;
    }
    this.goTo(index + 1);
  }

  private prev(): void {
    const index = this.driver?.getActiveIndex();
    if (index === undefined || index <= 0) return;
    this.goTo(index - 1);
  }

  /** Jump to any step, navigating first if it lives on another page. */
  goTo(index: number): void {
    const step = this.steps[index];
    if (step === undefined || this.driver === null) return;
    // Entering an agent-scoped step is the moment to pick a real agent: the
    // onboarding tour arrives from the directory, whose first row is the
    // newest registration. A later agent-scoped step keeps the same id
    // unless the finder has a better answer.
    if (step.route === 'agent-details' || step.route === 'review') {
      const found = this.deps.findAgentId();
      if (found !== null) this.agentId = found;
    }
    this.ensureRoute(step);
    this.driver.moveTo(index);
  }

  private ensureRoute(step: TourStepDef): void {
    const path = routeForStep(step, this.agentId);
    if (this.deps.currentPath() !== path) {
      this.pendingPath = path;
      this.deps.navigate(path);
    }
  }

  /**
   * Called on every route change. A path we did not request means the user is
   * navigating on their own, and the tour closes rather than fighting them.
   */
  handleLocationChange(path: string): void {
    if (!this.isActive()) return;
    if (this.pendingPath === path) {
      this.pendingPath = null;
      return;
    }
    const index = this.driver?.getActiveIndex();
    const step = index === undefined ? undefined : this.steps[index];
    if (step !== undefined && routeForStep(step, this.agentId) === path) return;
    this.driver?.destroy();
  }

  private handleDestroyed(reason: string | undefined): void {
    const result: TourEndReason =
      this.finishReason ?? (reason === 'done' ? 'completed' : 'dismissed');
    this.finishReason = null;
    this.pendingPath = null;
    if (!this.disposing) this.deps.persist(result);
    this.deps.onActiveChange?.(false);
  }

  /**
   * Unmount: tear the overlay down without recording a verdict. The
   * controller stays usable afterwards, because React StrictMode runs this
   * cleanup once on mount and the tour must still work after it.
   */
  dispose(): void {
    this.disposing = true;
    try {
      this.driver?.destroy();
    } finally {
      this.disposing = false;
    }
    this.driver = null;
  }
}
