"use client";

import { ChevronDown } from "lucide-react";
import { Select } from "@/components/ui";
import { REC_MODELS } from "@/lib/models";

/** The brief's "Model & cost" section. */
export function ModelSettings({
  model,
  changeModel,
  keySource,
  loading,
}: {
  model: string;
  changeModel: (next: string) => Promise<void>;
  keySource: "personal" | "shared" | "none";
  loading: boolean;
}) {
  return (
    <details className="group rounded-xl bg-surface-2/30 ring-1 ring-line">
      <summary className="focus-ring flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm font-medium marker:text-faint">
        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
          Model &amp; cost
          <span className="text-xs font-normal text-faint">
            {REC_MODELS.find((item) => item.id === model)?.label ?? "Claude"}
          </span>
        </span>
        <span
          aria-hidden="true"
          className="shrink-0 transition-transform duration-200 group-open:rotate-180"
        >
          <ChevronDown size={16} />
        </span>
      </summary>
      <div className="border-t border-line px-3 py-4">
        <label className="flex max-w-md flex-col gap-1">
          <span className="text-xs font-medium text-faint">Claude model</span>
          <Select
            name="recommendation-model"
            value={model}
            disabled={loading}
            onChange={(event) => void changeModel(event.target.value)}
          >
            {REC_MODELS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} · {item.note}
              </option>
            ))}
          </Select>
        </label>
        <p className="mt-2 text-xs text-muted">
          Larger requests and more capable models generally use more API quota.
        </p>
        <p className="mt-1 text-xs text-muted">
          {keySource === "personal"
            ? "Using your personal Anthropic key."
            : keySource === "shared"
              ? "Using this server's shared Anthropic key."
              : "No Anthropic key is available."}
        </p>
      </div>
    </details>
  );
}
