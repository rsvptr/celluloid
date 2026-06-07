"use client";

import { motion, MotionProvider } from "@/components/motion";

/**
 * Re-mounts per navigation (Next `template` semantics), so each route entrance
 * gets a subtle fade + rise. MotionProvider makes it respect reduced-motion.
 */
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  return (
    <MotionProvider>
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      >
        {children}
      </motion.div>
    </MotionProvider>
  );
}
