import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TourController } from './controller';
import type { TourDriverHandle, TourDriverHandlers, TourEndReason } from './controller';
import { FALLBACK_AGENT_ID, TOUR_STEPS, routeForStep, selectorFor } from './steps';
import { readTourStatus, shouldOfferTour, writeTourStatus } from './storage';
import type { TourStore } from './storage';
import { WelcomeDialogContent } from './TourProvider';

/* --- Step definitions ------------------------------------------------------ */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function readAllSource(dir: string): string {
  let out = '';
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out += readAllSource(path);
    else if (/\.(tsx|ts|css)$/.test(name)) out += readFileSync(path, 'utf8');
  }
  return out;
}

describe('tour steps', () => {
  it('defines the seven-step walkthrough with unique ids', () => {
    expect(TOUR_STEPS).toHaveLength(7);
    expect(new Set(TOUR_STEPS.map((step) => step.id)).size).toBe(7);
  });

  it('anchors every highlighted step to an element that exists in the app source', () => {
    // "Do not invent selectors": each anchor must appear in a page or
    // component, either as a literal data-tour attribute or a Card tourId.
    const source = readAllSource(SRC_DIR);
    for (const step of TOUR_STEPS) {
      if (step.anchor === null) continue;
      const asAttribute = source.includes(`data-tour="${step.anchor}"`);
      const asTourId = source.includes(`tourId="${step.anchor}"`);
      expect(asAttribute || asTourId, `anchor "${step.anchor}" not found in src`).toBe(true);
    }
  });

  it('ends with a centered completion step and starts on the dashboard', () => {
    expect(TOUR_STEPS[0]?.route).toBe('dashboard');
    const last = TOUR_STEPS[TOUR_STEPS.length - 1];
    expect(last?.anchor).toBeNull();
    expect(selectorFor(last!)).toBeNull();
  });

  it('explains the below-threshold state honestly', () => {
    const reputation = TOUR_STEPS.find((step) => step.id === 'agent-reputation');
    expect(reputation?.description).toContain('publishes no score');
  });

  it('never promises to run the gauntlet for the user', () => {
    const gauntlet = TOUR_STEPS.find((step) => step.id === 'attack-gauntlet');
    expect(gauntlet?.description).toContain('run the 10,000 trials yourself');
    expect(gauntlet?.description.toLowerCase()).toContain('synthetic');
  });

  it('maps routes, substituting the real agent id into agent-scoped steps', () => {
    const byId = Object.fromEntries(TOUR_STEPS.map((step) => [step.id, step]));
    expect(routeForStep(byId.dashboard!, '7')).toBe('/');
    expect(routeForStep(byId['agent-directory']!, '7')).toBe('/agents');
    expect(routeForStep(byId['agent-reputation']!, '7')).toBe('/agents/7');
    expect(routeForStep(byId['review-entry']!, '7')).toBe('/review/7');
    expect(routeForStep(byId['attack-gauntlet']!, '7')).toBe('/demo');
    expect(routeForStep(byId.finish!, '7')).toBe('/demo');
  });

  it('builds selectors from anchors', () => {
    expect(selectorFor(TOUR_STEPS[0]!)).toBe('[data-tour="dashboard-overview"]');
  });
});

/* --- Persistence ----------------------------------------------------------- */

function memoryStore(): TourStore & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

describe('tour storage', () => {
  it('offers the tour to a first-time visitor', () => {
    const store = memoryStore();
    expect(readTourStatus(store)).toBe('unseen');
    expect(shouldOfferTour(store)).toBe(true);
  });

  it('never re-offers after a dismissal', () => {
    const store = memoryStore();
    writeTourStatus('dismissed', store);
    expect(readTourStatus(store)).toBe('dismissed');
    expect(shouldOfferTour(store)).toBe(false);
  });

  it('never re-offers after completion', () => {
    const store = memoryStore();
    writeTourStatus('completed', store);
    expect(readTourStatus(store)).toBe('completed');
    expect(shouldOfferTour(store)).toBe(false);
  });

  it('treats corrupted or unexpected contents as a first visit', () => {
    const store = memoryStore();
    writeTourStatus('completed', store);
    const key = Array.from(store.data.keys())[0]!;
    store.data.set(key, 'not json');
    expect(readTourStatus(store)).toBe('unseen');
    store.data.set(key, JSON.stringify({ status: 'bogus' }));
    expect(readTourStatus(store)).toBe('unseen');
  });

  it('fails safe when storage is unavailable or throwing', () => {
    expect(readTourStatus(null)).toBe('unseen');
    expect(() => writeTourStatus('completed', null)).not.toThrow();
    const throwing: TourStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readTourStatus(throwing)).toBe('unseen');
    expect(() => writeTourStatus('dismissed', throwing)).not.toThrow();
  });
});

/* --- Welcome dialog -------------------------------------------------------- */

describe('welcome dialog', () => {
  it('shows the pitch and both choices', () => {
    const html = renderToStaticMarkup(
      <WelcomeDialogContent onStart={() => undefined} onDismiss={() => undefined} />,
    );
    expect(html).toContain(
      'Receipts helps you understand and verify the reputation of autonomous agents.',
    );
    expect(html).toContain('take a quick tour');
    expect(html).toContain('Start tour');
    expect(html).toContain('Maybe later');
  });
});

/* --- Controller ------------------------------------------------------------ */

/**
 * A stand-in for Driver.js that mirrors the behaviour the controller relies
 * on: drive/moveTo set the active index, destroy reports a reason to the
 * destroyed callback exactly once.
 */
class FakeDriver implements TourDriverHandle {
  index: number | undefined = undefined;
  active = false;
  destroyed = 0;

  constructor(private readonly handlers: TourDriverHandlers) {}

  drive(index = 0): void {
    this.active = true;
    this.index = index;
  }
  moveTo(index: number): void {
    this.index = index;
  }
  destroy(): void {
    this.endWith(undefined);
  }
  /** What Driver.js does when the user closes via ×, Escape or the overlay. */
  userClose(reason: 'close' | 'escape' | 'overlay'): void {
    this.endWith(reason);
  }
  private endWith(reason: string | undefined): void {
    if (!this.active) return;
    this.active = false;
    this.index = undefined;
    this.destroyed += 1;
    this.handlers.onDestroyed(reason);
  }
  isActive(): boolean {
    return this.active;
  }
  getActiveIndex(): number | undefined {
    return this.index;
  }
}

function harness(options: { startPath?: string; agentId?: string | null } = {}) {
  let path = options.startPath ?? '/';
  const navigations: string[] = [];
  const persisted: TourEndReason[] = [];
  const activeChanges: boolean[] = [];
  let driver: FakeDriver | null = null;
  let handlers: TourDriverHandlers | null = null;

  const controller = new TourController({
    navigate: (to) => {
      navigations.push(to);
      path = to;
    },
    currentPath: () => path,
    findAgentId: () => options.agentId ?? null,
    createDriver: (h) => {
      handlers = h;
      driver = new FakeDriver(h);
      return driver;
    },
    persist: (result) => void persisted.push(result),
    onActiveChange: (active) => void activeChanges.push(active),
  });

  return {
    controller,
    navigations,
    persisted,
    activeChanges,
    get driver() {
      if (driver === null) throw new Error('driver not created yet');
      return driver;
    },
    get handlers() {
      if (handlers === null) throw new Error('handlers not captured yet');
      return handlers;
    },
    /** Simulate the router reporting a path change. */
    locationChange(to: string) {
      path = to;
      controller.handleLocationChange(to);
    },
  };
}

describe('tour controller', () => {
  it('starts on the dashboard without navigating when already there', () => {
    const t = harness({ startPath: '/' });
    t.controller.start();
    expect(t.navigations).toEqual([]);
    expect(t.driver.getActiveIndex()).toBe(0);
    expect(t.activeChanges).toEqual([true]);
  });

  it('navigates home first when started from another page', () => {
    const t = harness({ startPath: '/demo' });
    t.controller.start();
    expect(t.navigations).toEqual(['/']);
    expect(t.driver.isActive()).toBe(true);
    // Our own navigation arriving must not close the tour.
    t.locationChange('/');
    expect(t.driver.isActive()).toBe(true);
  });

  it('walks forward across pages, reusing one real agent id for both agent steps', () => {
    const t = harness({ startPath: '/', agentId: '42' });
    t.controller.start();

    t.handlers.onNext();
    expect(t.navigations).toEqual(['/agents']);
    expect(t.driver.getActiveIndex()).toBe(1);
    t.locationChange('/agents');

    t.handlers.onNext();
    expect(t.navigations).toEqual(['/agents', '/agents/42']);
    expect(t.driver.getActiveIndex()).toBe(2);
    t.locationChange('/agents/42');

    t.handlers.onNext();
    expect(t.navigations).toEqual(['/agents', '/agents/42', '/review/42']);
    t.locationChange('/review/42');

    t.handlers.onNext();
    expect(t.navigations.at(-1)).toBe('/demo');
    t.locationChange('/demo');

    // Gauntlet, scenario explorer and the completion dialog share /demo.
    t.handlers.onNext();
    t.handlers.onNext();
    expect(t.navigations.at(-1)).toBe('/demo');
    expect(t.driver.getActiveIndex()).toBe(6);
    expect(t.driver.isActive()).toBe(true);
  });

  it('falls back to agent 1 when no agent link is on screen', () => {
    const t = harness({ startPath: '/', agentId: null });
    t.controller.start();
    t.handlers.onNext();
    t.locationChange('/agents');
    t.handlers.onNext();
    expect(t.navigations.at(-1)).toBe(`/agents/${FALLBACK_AGENT_ID}`);
  });

  it('supports moving backwards across pages', () => {
    const t = harness({ startPath: '/', agentId: '9' });
    t.controller.start();
    t.handlers.onNext();
    t.locationChange('/agents');
    t.handlers.onNext();
    t.locationChange('/agents/9');
    t.handlers.onPrev();
    expect(t.navigations.at(-1)).toBe('/agents');
    expect(t.driver.getActiveIndex()).toBe(1);
    t.locationChange('/agents');
    expect(t.driver.isActive()).toBe(true);
  });

  it('records completion when finishing on the last step', () => {
    const t = harness({ startPath: '/' });
    t.controller.start();
    for (let i = 0; i < TOUR_STEPS.length - 1; i++) {
      t.handlers.onNext();
      const current = t.navigations.at(-1);
      if (current !== undefined) t.locationChange(current);
    }
    expect(t.driver.getActiveIndex()).toBe(TOUR_STEPS.length - 1);
    t.handlers.onNext(); // "Explore the application"
    expect(t.driver.isActive()).toBe(false);
    expect(t.persisted).toEqual(['completed']);
    expect(t.activeChanges.at(-1)).toBe(false);
  });

  it('records a dismissal when the user skips mid-way', () => {
    const t = harness({ startPath: '/' });
    t.controller.start();
    t.handlers.onNext();
    t.driver.userClose('escape');
    expect(t.persisted).toEqual(['dismissed']);
    expect(t.activeChanges).toEqual([true, false]);
  });

  it('closes cleanly when the user navigates somewhere else', () => {
    const t = harness({ startPath: '/' });
    t.controller.start();
    t.locationChange('/docs');
    expect(t.driver.isActive()).toBe(false);
    expect(t.persisted).toEqual(['dismissed']);
  });

  it('tolerates repeated reports of the current step route', () => {
    const t = harness({ startPath: '/' });
    t.controller.start();
    t.locationChange('/');
    expect(t.driver.isActive()).toBe(true);
  });

  it('restarts from the completion dialog', () => {
    const t = harness({ startPath: '/' });
    t.controller.start();
    for (let i = 0; i < TOUR_STEPS.length - 1; i++) {
      t.handlers.onNext();
      const current = t.navigations.at(-1);
      if (current !== undefined) t.locationChange(current);
    }
    t.handlers.onRestart();
    expect(t.navigations.at(-1)).toBe('/');
    expect(t.driver.getActiveIndex()).toBe(0);
    expect(t.driver.isActive()).toBe(true);
    expect(t.persisted).toEqual([]);
  });

  it('restarts in place when the launcher is pressed mid-tour', () => {
    const t = harness({ startPath: '/' });
    t.controller.start();
    t.handlers.onNext();
    t.locationChange('/agents');
    t.controller.start();
    expect(t.driver.getActiveIndex()).toBe(0);
    expect(t.navigations.at(-1)).toBe('/');
  });

  it('cleans up on dispose without recording a verdict', () => {
    const t = harness({ startPath: '/' });
    t.controller.start();
    t.controller.dispose();
    expect(t.driver.isActive()).toBe(false);
    expect(t.driver.destroyed).toBe(1);
    expect(t.persisted).toEqual([]);
    expect(t.activeChanges).toEqual([true, false]);
  });

  it('starts again after a dispose, as under React StrictMode', () => {
    // StrictMode mounts, runs the unmount cleanup once, then mounts again:
    // dispose() must not poison the controller for the real session.
    const t = harness({ startPath: '/' });
    t.controller.dispose();
    t.controller.start();
    expect(t.driver.isActive()).toBe(true);
    expect(t.driver.getActiveIndex()).toBe(0);
  });
});

/* --- Styling --------------------------------------------------------------- */

describe('tour styling', () => {
  const css = readFileSync(join(SRC_DIR, 'tour', 'tour.css'), 'utf8');

  it('adapts the popover to narrow viewports', () => {
    expect(css).toContain('@media (max-width: 520px)');
    expect(css).toContain('max-width: calc(100vw - 32px)');
  });

  it('scopes every driver override so no styles leak into the app', () => {
    // Each selector that touches a driver.js class must be scoped by the
    // configured popoverClass; the welcome-dialog classes are tour-prefixed.
    const selectors = css
      .split('}')
      .map((block) => block.split('{')[0]?.trim() ?? '')
      .filter((selector) => selector.includes('.driver-'));
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector.includes('.receipts-tour'), `unscoped selector: ${selector}`).toBe(true);
    }
  });

  it('uses design tokens rather than a new palette', () => {
    expect(css).toContain('var(--surface-card)');
    expect(css).toContain('var(--border-strong)');
    expect(css).toContain('var(--radius-lg)');
    // No light-theme or off-palette hex colours; the two raised-hover hexes
    // are the ones ui.module.css itself uses for the primary button.
    const hexes = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(new Set(hexes)).toEqual(new Set(['#2a2a30', '#48484f']));
  });
});
