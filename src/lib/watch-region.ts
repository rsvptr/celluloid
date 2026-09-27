import { DEFAULT_WATCH_REGION, isWatchRegion } from "@/lib/tmdb-extras";

/**
 * Streaming-region precedence shared by any surface that combines device and
 * account state: a valid per-device cookie wins, then the saved preference,
 * then Celluloid's built-in default.
 */
export function resolveWatchRegion(
  deviceRegion: string | null | undefined,
  savedRegion: string | null | undefined,
): string {
  if (isWatchRegion(deviceRegion)) return deviceRegion;
  if (isWatchRegion(savedRegion)) return savedRegion;
  return DEFAULT_WATCH_REGION;
}
