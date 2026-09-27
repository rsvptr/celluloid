"use client";

import { Info } from "lucide-react";
import { TmdbAttribution } from "@/components/tmdb-attribution";
import { Section } from "./settings-ui";

// TMDB's terms put the attribution in an "About" or "Credits" type section.
export function AboutSection() {
  return (
    <Section icon={Info} title="About" description="Where Celluloid's data comes from.">
      <div className="flex flex-col gap-3">
        <TmdbAttribution />
        <p className="text-xs text-faint">Streaming availability via JustWatch.</p>
      </div>
    </Section>
  );
}
