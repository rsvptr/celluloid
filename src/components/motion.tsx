"use client";

import * as React from "react";
import * as m from "motion/react-m";
import {
  AnimatePresence,
  LazyMotion,
  MotionConfig,
  useIsPresent,
  useReducedMotion,
} from "motion/react";

// Re-export the bits the rest of the app uses so imports stay in one place.
// Consumers keep the existing `motion.div` spelling, but the value is Motion's
// lean `m` component and receives its features from MotionProvider below.
export { AnimatePresence, m as motion, useReducedMotion };

// `layout` (recommendation cards) needs domMax rather than domAnimation.
// The async feature import keeps that larger feature bundle
// out of the app shell's initial JS while the statically analyzable path lets
// Next split it into its own chunk. If the chunk fails to load (flaky network,
// a blocker, deploy skew), `m` components simply stay feature-less: the promise
// never settles, so there is no unhandled rejection and no half-loaded state.
// Nothing server-rendered starts hidden, so that costs animation, not content.
// Client-mounted entrances do start hidden, so the failure also flags <html>:
// globals.css then shows every `data-motion-enter` element at rest, including
// ones that mounted while the chunk was still pending.
const loadDomMax = () =>
  import("motion/react")
    .then((module) => {
      delete document.documentElement.dataset.motionFailed;
      return module.domMax;
    })
    .catch(() => {
      document.documentElement.dataset.motionFailed = "";
      return new Promise<never>(() => {});
    });

// Motion's copies of the curves in globals.css's motion tokens (EM-14); keep
// the two in step (tests/motion-tokens.test.ts checks).
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
export const EASE_DRAWER = [0.32, 0.72, 0, 1] as const;

/**
 * Mounted by the app layout and the login page so every Motion animation
 * honors the OS "reduce motion" setting. Motion drives animations via JS, so
 * the CSS media query in globals.css cannot provide this guarantee on its own.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={loadDomMax} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

/**
 * Content wrapper for an AnimatePresence child that makes it inert while the
 * child plays its exit, so a closing panel leaves the tab order at once rather
 * than when Motion unmounts it.
 */
export function InertOnExit({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const isPresent = useIsPresent();
  return (
    <div className={className} inert={!isPresent}>
      {children}
    </div>
  );
}
