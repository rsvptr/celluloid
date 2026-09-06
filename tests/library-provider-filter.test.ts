import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { register } from "node:module";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/celluloid_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-that-is-at-least-32-chars";
process.env.TMDB_ACCESS_TOKEN ??= "test-tmdb-token";

const serverOnlyShim = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return nextResolve(specifier, {
      ...context,
      conditions: [...context.conditions, "react-server"],
    });
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(serverOnlyShim)}`, import.meta.url);

const { serviceAvailabilityState, uncheckedProviderCopy } = await import(
  "../src/components/library"
);

const checked = {
  tmdbId: 10,
  status: "WATCHLIST" as const,
  providersRegion: "GB",
  providersSyncedAt: "2026-08-30T00:00:00.000Z",
  streamProviderIds: [8, 9],
};

describe("On my services availability state", () => {
  it("distinguishes confirmed matches from confirmed non-matches", () => {
    assert.equal(serviceAvailabilityState(checked, "GB", new Set([8])), "MATCH");
    assert.equal(serviceAvailabilityState(checked, "GB", new Set([337])), "NO_MATCH");
  });

  it("counts missing and wrong-region caches as unchecked", () => {
    assert.equal(
      serviceAvailabilityState(
        { ...checked, providersSyncedAt: null },
        "GB",
        new Set([8]),
      ),
      "UNCHECKED",
    );
    assert.equal(
      serviceAvailabilityState(
        { ...checked, providersRegion: "US" },
        "GB",
        new Set([8]),
      ),
      "UNCHECKED",
    );
  });

  it("does not call unmatched or DROPPED titles unchecked", () => {
    assert.equal(
      serviceAvailabilityState({ ...checked, tmdbId: null }, "GB", new Set([8])),
      "INELIGIBLE",
    );
    assert.equal(
      serviceAvailabilityState(
        { ...checked, status: "DROPPED" },
        "GB",
        new Set([8]),
      ),
      "INELIGIBLE",
    );
  });

  it("matches on the account region even when the device cookie says elsewhere", () => {
    // D-008: the nightly sync stamps the account region onto every cached row,
    // so that is the region the library evaluates in. A phone whose region
    // cookie still said GB used to read the whole library as unchecked.
    const accountRegion = "US";
    const deviceCookieRegion = "GB";
    const synced = { ...checked, providersRegion: accountRegion };
    assert.equal(serviceAvailabilityState(synced, accountRegion, new Set([8])), "MATCH");
    assert.equal(
      serviceAvailabilityState(synced, accountRegion, new Set([337])),
      "NO_MATCH",
    );
    assert.equal(
      serviceAvailabilityState(synced, deviceCookieRegion, new Set([8])),
      "UNCHECKED",
    );
  });

  it("uses honest singular and plural unchecked copy", () => {
    assert.equal(uncheckedProviderCopy(1), "1 title not checked yet");
    assert.equal(uncheckedProviderCopy(3), "3 titles not checked yet");
  });
});
