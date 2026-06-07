"use client";

import * as React from "react";
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  MotionConfig,
  useReducedMotion,
} from "motion/react";

// Re-export the bits the rest of the app uses so imports stay in one place.
export { AnimatePresence, LayoutGroup, motion, useReducedMotion };

// A cinematic ease-out curve used for most entrances.
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/**
 * Wraps a subtree so motion animations honor the OS "reduce motion" setting.
 * Needed because motion drives animations via JS (not CSS transitions), so the
 * `prefers-reduced-motion` rule in globals.css does not reach them on its own.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

export function FadeIn({
  children,
  className,
  delay = 0,
  y = 8,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  y?: number;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE_OUT, delay }}
    >
      {children}
    </motion.div>
  );
}

const containerVariants = {
  hidden: {},
  show: (stagger: number) => ({
    transition: { staggerChildren: stagger, delayChildren: 0.02 },
  }),
};

export const staggerItem = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE_OUT } },
};

/** Container that fades its `StaggerItem` children in one after another. */
export function Stagger({
  children,
  className,
  stagger = 0.035,
}: {
  children: React.ReactNode;
  className?: string;
  stagger?: number;
}) {
  return (
    <motion.div
      className={className}
      variants={containerVariants}
      initial="hidden"
      animate="show"
      custom={stagger}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div className={className} variants={staggerItem}>
      {children}
    </motion.div>
  );
}
