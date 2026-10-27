import { useEffect, useState } from "react";

export type Resource<A> =
  | { readonly status: "loading"; readonly data?: A }
  | { readonly status: "error"; readonly error: unknown; readonly data?: A }
  | { readonly status: "ready"; readonly data: A };

/**
 * Loads data for a key and reloads when the key changes. A `null` key skips
 * loading. Previous data is kept while refreshing so screens don't flash.
 */
export function useResource<A>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<A>,
): Resource<A> & { readonly reload: () => void } {
  const [state, setState] = useState<Resource<A>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const reload = () => setAttempt((value) => value + 1);

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    setState((previous) => ({ status: "loading", data: previous.data }));
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setState((previous) => ({ status: "error", error, data: previous.data }));
      },
    );

    return () => controller.abort();
    // `load` closes over the key; reloading on identity would loop.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  return { ...state, reload };
}
