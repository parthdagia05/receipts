/*
 * First-visit persistence for the tour.
 *
 * One key, one small JSON value. `localStorage` can be absent (SSR, tests) or
 * throw (private browsing), so every access is guarded and the failure mode is
 * always "behave like a visitor whose preference we don't know" — except that
 * a visitor we cannot remember must not be re-prompted on every navigation,
 * so a throwing store reports `unseen` once and the welcome dialog's own
 * dismissal still works for the session.
 */

/** Onboarding-tour progress. */
const TOUR_KEY = 'receipts.tour.v1';

export type TourStatus = 'unseen' | 'dismissed' | 'completed';

/** The subset of the Web Storage API the tour needs; injectable for tests. */
export interface TourStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): TourStore | null {
  try {
    // `localStorage` itself can throw on access in some privacy modes.
    const store = globalThis.localStorage;
    return store ?? null;
  } catch {
    return null;
  }
}

export function readTourStatus(
  store: TourStore | null = defaultStore(),
  key: string = TOUR_KEY,
): TourStatus {
  if (store === null) return 'unseen';
  try {
    const raw = store.getItem(key);
    if (raw === null) return 'unseen';
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'status' in parsed) {
      const status = (parsed as { status: unknown }).status;
      if (status === 'dismissed' || status === 'completed') return status;
    }
    // Unrecognised contents: treat as a first visit rather than guessing.
    return 'unseen';
  } catch {
    return 'unseen';
  }
}

export function writeTourStatus(
  status: Exclude<TourStatus, 'unseen'>,
  store: TourStore | null = defaultStore(),
  key: string = TOUR_KEY,
): void {
  if (store === null) return;
  try {
    store.setItem(key, JSON.stringify({ status, at: new Date().toISOString() }));
  } catch {
    /* Preference simply does not persist. */
  }
}

/** The welcome dialog is offered exactly once: only to visitors with no
 *  recorded completion or dismissal. */
export function shouldOfferTour(store: TourStore | null = defaultStore()): boolean {
  return readTourStatus(store) === 'unseen';
}
