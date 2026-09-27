"use client";

import { useEffect, useRef } from "react";
import { RefreshCw, Square } from "lucide-react";
import type { Recommendation } from "@/lib/recommend";
import { Card, Spinner } from "@/components/ui";
import { Shimmer } from "@/components/skeleton";
import { AnimatePresence, EASE_OUT, motion } from "@/components/motion";
import { RecCard, type DismissReason } from "./rec-card";
import {
  recommendationIdentity,
  type RecommendState,
  type StreamPhase,
} from "./recommend-state";

const PHASE_LABEL: Record<StreamPhase, string> = {
  starting: "Reading your taste brief…",
  thinking: "Thinking about what fits your taste…",
  generating: "Picking titles…",
};

/** The run's live status, its cards as they stream in, and the empty result. */
export function RecResults({
  run,
  count,
  pickEmpty,
  stop,
  generate,
  dismiss,
}: {
  run: RecommendState;
  count: number;
  pickEmpty: boolean;
  stop: () => void;
  generate: () => Promise<void>;
  dismiss: (rec: Recommendation, index: number, reason: DismissReason) => Promise<void>;
}) {
  const loading = run.status === "streaming";
  const { recs } = run;
  const receivedAny = run.received.length > 0;
  const resultsRef = useRef<HTMLDivElement>(null);

  // Bring results into view as soon as the first suggestion streams in (on
  // mobile they sit below the form).
  const recCount = recs.length;
  const hasResults = recCount > 0;
  useEffect(() => {
    if (hasResults) {
      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      resultsRef.current?.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start",
      });
    }
  }, [hasResults]);

  return (
    <>
      {(loading || recs.length > 0 || receivedAny) && (
        <div ref={resultsRef} className="flex scroll-mt-20 flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            {/* One live region for the whole run. Swapping it for a plain
                paragraph on completion would tear the node out before the
                announcement could fire, so the run would go silent exactly when
                there was something to say — the same element switches from
                progress to the final count instead. */}
            <p
              role="status"
              aria-live="polite"
              className="flex items-center gap-2 text-xs text-muted"
            >
              {run.status === "streaming" ? (
                <>
                  <Spinner className="shrink-0" />
                  {PHASE_LABEL[run.phase]}
                  {recCount > 0 ? (
                    <span className="tabular-nums">
                      {recCount} of {count} found
                    </span>
                  ) : null}
                </>
              ) : (
                `${recCount} ${recCount === 1 ? "suggestion" : "suggestions"} ready`
              )}
            </p>
            {loading ? (
              <button
                type="button"
                onClick={stop}
                className="focus-ring flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted ring-1 ring-line transition-colors hover:text-foreground sm:min-h-0"
              >
                <Square size={13} aria-hidden="true" />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => generate()}
                disabled={pickEmpty}
                className="focus-ring flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted ring-1 ring-line transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
              >
                <RefreshCw size={16} aria-hidden="true" />
                Show different picks
              </button>
            )}
          </div>

          {/* relative: popLayout positions an exiting card against this grid. */}
          <div className="relative grid grid-cols-1 gap-3 lg:grid-cols-2">
            {/* popLayout takes a dismissed card out of the flow as its exit
                starts, so the others move at once instead of after it (EM-12). */}
            <AnimatePresence initial={false} mode="popLayout">
                {recs.map((r, index) => (
                  <motion.div
                    key={recommendationIdentity(r)}
                    // MO-06: measure only when the list changes, not on every
                    // keystroke in the focus box, and move without scaling, so
                    // a card landing in a row of another height isn't squashed.
                    layout="position"
                    layoutDependency={recs}
                    data-motion-enter
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15, ease: EASE_OUT } }}
                    transition={{
                      duration: 0.3,
                      ease: EASE_OUT,
                      layout: { type: "spring", visualDuration: 0.3, bounce: 0 },
                    }}
                    className="min-w-0"
                  >
                    <RecCard
                      rec={r}
                      onDismiss={(reason) => void dismiss(r, index, reason)}
                    />
                  </motion.div>
                ))}
            </AnimatePresence>

            {loading &&
              Array.from({ length: Math.min(2, Math.max(1, count - recs.length)) }).map(
                (_, i) => (
                  <Card key={`skeleton-${i}`} className="flex min-w-0 items-start gap-3 p-3">
                    <Shimmer className="h-[84px] w-14 shrink-0" />
                    <div className="flex flex-1 flex-col gap-2 py-1">
                      <Shimmer className="h-4 w-2/5" />
                      <Shimmer className="h-3 w-1/4" />
                      <Shimmer className="h-3 w-full" />
                    </div>
                  </Card>
                ),
              )}
          </div>
        </div>
      )}

      {run.status === "done" && recs.length === 0 && (
        <p className="py-8 text-center text-sm text-muted">
          {receivedAny
            ? "You've hidden every suggestion from this run. Try “Show different picks” for another batch."
            : run.stopped
              ? "Stopped before any suggestions came back."
              : "No suggestions came back. Try a different focus or count."}
        </p>
      )}
    </>
  );
}
