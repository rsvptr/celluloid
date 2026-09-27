"use client";

import * as React from "react";
import * as m from "motion/react-m";
import {
  AnimatePresence,
  LazyMotion,
  LayoutGroup,
  MotionConfig,
  useReducedMotion,
} from "motion/react";

// Re-export the bits the rest of the app uses so imports stay in one place.
// Consumers keep the existing `motion.div` spelling, but the value is Motion's
// lean `m` component and receives its features from MotionProvider below.
export { AnimatePresence, LayoutGroup, m as motion, useReducedMotion };

// `layout` (recommendation cards) and `layoutId` (nav pill) need domMax rather
// than domAnimation. The async feature import keeps that larger feature bundle
// out of the app shell's initial JS while the statically analyzable path lets
// Next split it into its own chunk. If the chunk fails to load (flaky network,
// a blocker, deploy skew), `m` components simply stay feature-less: the promise
// never settles, so there is no unhandled rejection and no half-loaded state.
// Nothing server-rendered starts hidden, so that costs animation, not content.
const loadDomMax = () =>
  import("motion/react")
    .then((module) => module.domMax)
    .catch(() => new Promise<never>(() => {}));

// A cinematic ease-out curve used for most entrances.
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

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
