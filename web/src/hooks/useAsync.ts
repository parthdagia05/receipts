import { useCallback, useEffect, useState } from 'react';

/**
 * Run an async read and expose its four states explicitly.
 *
 * Every data-backed surface in this app distinguishes loading, error, empty
 * and loaded. Collapsing "failed to read" into "no data" would make an RPC
 * outage look like a genuine absence of agents or reviews, which is exactly
 * the kind of fabricated certainty the product must avoid.
 *
 * The result of a superseded run is discarded, so a fast second request cannot
 * be overwritten by a slow first one.
 */

export interface AsyncState<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: Error | null;
  reload: () => void;
}

export function useAsync<T>(
  run: () => Promise<T>,
  deps: readonly unknown[],
  options?: { readonly enabled?: boolean },
): AsyncState<T> {
  const enabled = options?.enabled ?? true;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  // `run` is typically an inline arrow, so it is a new function on every
  // render. The caller's `deps` decide when to re-run, exactly as useEffect's
  // contract works.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const callback = useCallback(run, deps);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    callback()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [callback, enabled, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  return { data, loading, error, reload };
}
