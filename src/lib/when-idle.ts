/**
 * Calls `run` once the browser is idle, or after 2 s at the latest, and
 * returns a cancel function, so it can be returned from an effect. Where
 * requestIdleCallback is missing (older Safari), a short timer stands in.
 */
export function whenIdle(run: () => void): () => void {
  // typeof probe rather than `in`: lib.dom declares requestIdleCallback
  // unconditionally, so an `in` check narrows the else branch to `never`.
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(run, { timeout: 2000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 300);
  return () => window.clearTimeout(id);
}
