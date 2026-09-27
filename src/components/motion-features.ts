// motion.tsx's lazy LazyMotion features: domMax alone, so the async chunk
// doesn't carry the rest of the motion/react namespace (MO-03).
import { domMax } from "motion/react";

export default domMax;
