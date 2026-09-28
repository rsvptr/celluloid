/**
 * Wraps a dynamic import() so a failed chunk load gets one immediate retry,
 * and a load that fails twice is forgotten rather than cached: the next call
 * tries again (P7U-1). A success is memoized, like import() itself.
 */
export function retryingLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () =>
    (pending ??= load()
      .catch(() => load())
      .catch((error: unknown) => {
        pending = null;
        throw error;
      }));
}

export interface LazyDialogState {
  failed: boolean;
  wasOpen: boolean;
}

/**
 * A lazy dialog's boundary state for its next `open` prop. A failed load keeps
 * showing the fallback while the dialog stays closed, so an offline page never
 * retries in a loop. When a fallback that was open closes, the failure clears
 * and the next render tries the chunk again.
 */
export function nextLazyDialogState(state: LazyDialogState, open: boolean): LazyDialogState {
  if (state.failed && state.wasOpen && !open) return { failed: false, wasOpen: false };
  return { failed: state.failed, wasOpen: open };
}
