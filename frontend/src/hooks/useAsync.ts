import { useCallback, useEffect, useRef, useState } from "react";

export type AsyncState<T> = {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
};

/** Run an async loader on mount / when deps change, optionally refreshing every `refreshMs`. */
export function useAsync<T>(
  load: () => Promise<T>,
  deps: unknown[],
  opts: { refreshMs?: number } = {},
): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    const run = (initial: boolean) => {
      if (initial) setLoading(true);
      loadRef
        .current()
        .then((v) => {
          if (!alive) return;
          setData(v);
          setError(undefined);
        })
        .catch((e: unknown) => {
          if (alive) setError(e instanceof Error ? e : new Error(String(e)));
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    };
    run(true);
    const id = opts.refreshMs ? setInterval(() => run(false), opts.refreshMs) : undefined;
    return () => {
      alive = false;
      if (id) clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, opts.refreshMs]);

  return { data, error, loading, reload };
}
