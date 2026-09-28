"use client";

import { Component, lazy, Suspense, type ComponentType } from "react";
import { nextLazyDialogState, retryingLoader, type LazyDialogState } from "@/lib/retry-load";

/**
 * A dialog whose markup loads in its own chunk (VE-11), with a fallback for
 * when that chunk won't load (P7U-1). Suspense with a null fallback keeps
 * loading from suspending the page, like next/dynamic's ssr: false.
 *
 * React.lazy caches a rejected load for good, and an uncaught one reaches the
 * route's error screen even though no dialog was opened. So a failed load
 * renders `Fallback` with the same props instead, and a fresh lazy component
 * takes over, which the boundary tries once the fallback has been used.
 */
export function lazyDialog<P extends { open: boolean }>(
  load: () => Promise<ComponentType<P>>,
  Fallback: ComponentType<P>,
): ComponentType<P> {
  const loadView = retryingLoader(load);
  const lazyView = () => lazy(() => loadView().then((View) => ({ default: View })));
  let View = lazyView();

  class LazyDialog extends Component<P, LazyDialogState> {
    state: LazyDialogState = { failed: false, wasOpen: this.props.open };

    static getDerivedStateFromError(): Partial<LazyDialogState> {
      return { failed: true };
    }

    static getDerivedStateFromProps(props: { open: boolean }, state: LazyDialogState) {
      return nextLazyDialogState(state, props.open);
    }

    // Swapped only after the boundary has caught the failure, so no render
    // can meet a fresh lazy (and start another load) before the fallback shows.
    componentDidCatch() {
      View = lazyView();
    }

    render() {
      if (this.state.failed) return <Fallback {...this.props} />;
      return (
        <Suspense fallback={null}>
          <View {...this.props} />
        </Suspense>
      );
    }
  }
  return LazyDialog;
}
