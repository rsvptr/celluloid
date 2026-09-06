import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  orderSharedTitles,
  shareIsAvailable,
  shareLifecycleState,
  shareTitleVisibility,
  type ShareVisibilityConfig,
} from "../src/lib/data";
import type { WatchStatus } from "../src/generated/prisma/client";

// WatchStatus is a string enum whose members equal their own names at runtime,
// so casting a string literal is behaviourally identical to the enum value and
// keeps this unit test free of the generated Prisma runtime.
const title = (
  status: string,
  notes: string | null = "spoilers ahead",
  rating: number | null = 4,
  favorite = true,
) => ({
  status: status as WatchStatus,
  notes,
  rating,
  favorite,
});

const WHOLE_LIBRARY: ShareVisibilityConfig = {
  isWholeLibrary: true,
  includeWatchlist: false,
  includeNotes: false,
};

const EXPLICIT: ShareVisibilityConfig = {
  isWholeLibrary: false,
  includeWatchlist: false,
  includeNotes: false,
};

const OTHER_STATUSES = ["WATCHED", "WATCHING", "ON_HOLD", "DROPPED"];

describe("shareTitleVisibility — notes", () => {
  it("omits notes when includeNotes is false", () => {
    const d = shareTitleVisibility(WHOLE_LIBRARY, title("WATCHED", "my note"));
    assert.equal(d.notes, null);
  });

  it("keeps notes when includeNotes is true", () => {
    const d = shareTitleVisibility(
      { ...WHOLE_LIBRARY, includeNotes: true },
      title("WATCHED", "my note"),
    );
    assert.equal(d.notes, "my note");
  });

  it("leaves an absent note null even when includeNotes is true", () => {
    const d = shareTitleVisibility(
      { ...WHOLE_LIBRARY, includeNotes: true },
      title("WATCHED", null),
    );
    assert.equal(d.notes, null);
  });
});

describe("shareTitleVisibility — rating and favorite (D-001)", () => {
  it("hides rating and favorite when includeNotes is false", () => {
    const d = shareTitleVisibility(WHOLE_LIBRARY, title("WATCHED", "my note", 4.5, true));
    assert.equal(d.rating, null);
    assert.equal(d.favorite, false);
  });

  it("keeps rating and favorite when includeNotes is true", () => {
    const d = shareTitleVisibility(
      { ...WHOLE_LIBRARY, includeNotes: true },
      title("WATCHED", "my note", 4.5, true),
    );
    assert.equal(d.rating, 4.5);
    assert.equal(d.favorite, true);
  });

  it("treats a missing rating/favorite as unrated/not-favorited rather than throwing", () => {
    const d = shareTitleVisibility(
      { ...WHOLE_LIBRARY, includeNotes: true },
      { status: "WATCHED" as WatchStatus, notes: null },
    );
    assert.equal(d.rating, null);
    assert.equal(d.favorite, false);
  });
});

describe("shareTitleVisibility — whole-library visibility", () => {
  it("hides WATCHLIST titles by default", () => {
    assert.equal(
      shareTitleVisibility(WHOLE_LIBRARY, title("WATCHLIST")).visible,
      false,
    );
  });

  it("shows WATCHLIST titles when includeWatchlist is set", () => {
    assert.equal(
      shareTitleVisibility(
        { ...WHOLE_LIBRARY, includeWatchlist: true },
        title("WATCHLIST"),
      ).visible,
      true,
    );
  });

  it("shows every non-WATCHLIST status regardless of the opt-in", () => {
    for (const s of OTHER_STATUSES) {
      assert.equal(
        shareTitleVisibility(WHOLE_LIBRARY, title(s)).visible,
        true,
        `expected ${s} to be visible`,
      );
    }
  });
});

describe("shareTitleVisibility — explicit selection", () => {
  it("shows explicitly-picked titles regardless of status, including WATCHLIST", () => {
    for (const s of ["WATCHLIST", ...OTHER_STATUSES]) {
      assert.equal(
        shareTitleVisibility(EXPLICIT, title(s)).visible,
        true,
        `expected explicitly-selected ${s} to be visible`,
      );
    }
  });
});

describe("share lifecycle", () => {
  const now = new Date("2026-07-17T12:00:00.000Z");

  it("keeps a link available before its expiry", () => {
    assert.equal(
      shareIsAvailable(
        { expiresAt: new Date("2026-07-18T12:00:00.000Z"), revokedAt: null },
        now,
      ),
      true,
    );
  });

  it("rejects links at expiry and after revocation", () => {
    assert.equal(
      shareIsAvailable({ expiresAt: now, revokedAt: null }, now),
      false,
    );
    assert.equal(
      shareIsAvailable({ expiresAt: null, revokedAt: new Date() }, now),
      false,
    );
  });

  it("reports revoked ahead of expired for settings presentation", () => {
    assert.equal(
      shareLifecycleState(
        { expiresAt: new Date("2026-07-16T12:00:00.000Z"), revokedAt: now },
        now,
      ),
      "REVOKED",
    );
    assert.equal(
      shareLifecycleState({ expiresAt: now, revokedAt: null }, now),
      "EXPIRED",
    );
  });
});

describe("curated share ordering", () => {
  it("follows saved membership positions and ignores missing titles", () => {
    const titles = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ];
    assert.deepEqual(orderSharedTitles(titles, ["c", "missing", "a", "b"]), [
      titles[2],
      titles[0],
      titles[1],
    ]);
  });
});
