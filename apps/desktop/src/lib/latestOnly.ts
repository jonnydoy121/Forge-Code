// For an effect that loads something asynchronously from an input that changes (the active file, a search text): when loads overlap,
// the last one to FINISH is not necessarily the last one to START, and a slow older load must not overwrite a newer result. Only the
// most recent `run` may apply its result; `cancel` (the effect's cleanup) drops whatever is still in flight.
export function latestOnly<T>(apply: (value: T) => void) {
  let ticket = 0;
  return {
    /** Apply `load`'s result unless a newer `run` or a `cancel` came first. A failed load is dropped like any stale one. */
    run(load: Promise<T>) {
      const mine = ++ticket;
      void load.then(
        (value) => {
          if (mine === ticket) apply(value);
        },
        () => {},
      );
    },
    /** Like `run`, but a failed (current) load is handled by `onError` instead of being ignored. */
    runOr(load: Promise<T>, onError: (e: unknown) => void) {
      const mine = ++ticket;
      void load.then(
        (value) => {
          if (mine === ticket) apply(value);
        },
        (e) => {
          if (mine === ticket) onError(e);
        },
      );
    },
    cancel() {
      ticket++;
    },
  };
}
