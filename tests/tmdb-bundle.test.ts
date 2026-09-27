import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  imdbUrl,
  pickCreators,
  pickDirector,
  pickMovieCertification,
  pickTopCast,
  pickTvCertification,
} from "../src/lib/tmdb-extras";

// Fixtures are shaped per the TMDB docs (release_dates / content_ratings /
// credits / aggregate_credits / external_ids / created_by). They are left
// untyped so the extra fields TMDB returns don't trip excess-property checks.

describe("pickMovieCertification", () => {
  // results[].iso_3166_1 + results[].release_dates[].certification
  const results = [
    {
      iso_3166_1: "US",
      release_dates: [
        { certification: "", type: 1, note: "Premiere" },
        { certification: "R", type: 3 },
      ],
    },
    { iso_3166_1: "GB", release_dates: [{ certification: "18", type: 3 }] },
    { iso_3166_1: "SG", release_dates: [{ certification: "M18 ", type: 3 }] },
  ];

  it("prefers the requested region, skipping empty certifications", () => {
    // US's first release has an empty cert; the theatrical "R" is chosen.
    assert.deepEqual(pickMovieCertification(results), { rating: "R", region: "US" });
    assert.deepEqual(pickMovieCertification(results, "GB"), { rating: "18", region: "GB" });
  });

  it("trims trailing whitespace on the certification", () => {
    assert.deepEqual(pickMovieCertification(results, "SG"), { rating: "M18", region: "SG" });
  });

  it("falls back to the US when the region is missing, and says so", () => {
    assert.deepEqual(pickMovieCertification(results, "FR"), { rating: "R", region: "US" });
  });

  // Bramayugam (/movie/1166133), live: regions come back alphabetically, and
  // the US never rated it. Spain's "16" used to show, unlabelled.
  const bramayugam = [
    { iso_3166_1: "AU", release_dates: [{ certification: "", type: 1 }] },
    { iso_3166_1: "ES", release_dates: [{ certification: "16", type: 3 }] },
    { iso_3166_1: "FR", release_dates: [{ certification: "TP", type: 3 }] },
    { iso_3166_1: "GB", release_dates: [{ certification: "15", type: 3 }] },
    { iso_3166_1: "IN", release_dates: [{ certification: "U/A 16+", type: 3 }] },
    { iso_3166_1: "SE", release_dates: [{ certification: "", type: 1 }] },
  ];

  it("takes the title's own country before the US and any other region (TM-08)", () => {
    assert.deepEqual(pickMovieCertification(bramayugam, "US", ["IN"]), {
      rating: "U/A 16+",
      region: "IN",
    });
    assert.deepEqual(pickMovieCertification(bramayugam, "GB", ["IN"]), {
      rating: "15",
      region: "GB",
    });
  });

  it("labels whichever region an any-region fallback came from", () => {
    assert.deepEqual(pickMovieCertification(bramayugam, "US"), { rating: "16", region: "ES" });
  });

  it("falls back when the region exists but has only empty certs", () => {
    const withEmptyRegion = [
      { iso_3166_1: "XX", release_dates: [{ certification: "   ", type: 1 }] },
      { iso_3166_1: "DE", release_dates: [{ certification: "16", type: 3 }] },
    ];
    assert.deepEqual(pickMovieCertification(withEmptyRegion, "XX"), { rating: "16", region: "DE" });
  });

  it("returns null for empty or all-empty input", () => {
    assert.equal(pickMovieCertification(undefined), null);
    assert.equal(pickMovieCertification([]), null);
    assert.equal(
      pickMovieCertification([
        { iso_3166_1: "US", release_dates: [{ certification: "", type: 1 }] },
      ]),
      null,
    );
  });
});

describe("pickTvCertification", () => {
  // results[].iso_3166_1 + results[].rating
  const results = [
    { descriptors: [], iso_3166_1: "DE", rating: "16" },
    { descriptors: [], iso_3166_1: "US", rating: "TV-MA" },
    { descriptors: [], iso_3166_1: "GB", rating: "18" },
    { descriptors: [], iso_3166_1: "SG", rating: "R21 " },
  ];

  it("prefers the requested region", () => {
    assert.deepEqual(pickTvCertification(results), { rating: "TV-MA", region: "US" });
    assert.deepEqual(pickTvCertification(results, "GB"), { rating: "18", region: "GB" });
  });

  it("trims the rating", () => {
    assert.deepEqual(pickTvCertification(results, "SG"), { rating: "R21", region: "SG" });
  });

  it("falls back to the origin country, then the US, then the first rating", () => {
    assert.deepEqual(pickTvCertification(results, "FR", ["DE"]), { rating: "16", region: "DE" });
    assert.deepEqual(pickTvCertification(results, "FR"), { rating: "TV-MA", region: "US" });
    assert.deepEqual(pickTvCertification([results[0]], "FR"), { rating: "16", region: "DE" });
  });

  it("returns null for empty or all-empty input", () => {
    assert.equal(pickTvCertification(undefined), null);
    assert.equal(pickTvCertification([]), null);
    assert.equal(
      pickTvCertification([{ iso_3166_1: "US", rating: "" }]),
      null,
    );
  });
});

describe("pickTopCast", () => {
  it("reads movie credits.cast, sorts by billing order, and flattens", () => {
    const credits = {
      cast: [
        { id: 2, name: "Brad Pitt", character: "Tyler Durden", profile_path: "/bp.jpg", order: 1 },
        { id: 1, name: "Edward Norton", character: "The Narrator", profile_path: "/en.jpg", order: 0 },
        { id: 3, name: "Helena Bonham Carter", character: "Marla ", profile_path: null, order: 2 },
      ],
    };
    assert.deepEqual(pickTopCast(credits), [
      { name: "Edward Norton", character: "The Narrator", profilePath: "/en.jpg" },
      { name: "Brad Pitt", character: "Tyler Durden", profilePath: "/bp.jpg" },
      { name: "Helena Bonham Carter", character: "Marla", profilePath: null },
    ]);
  });

  it("reads TV aggregate_credits.cast, taking character from roles[0]", () => {
    const credits = {
      cast: [
        {
          id: 1,
          name: "Emilia Clarke",
          roles: [{ character: "Daenerys Targaryen", episode_count: 78 }],
          total_episode_count: 78,
          order: 6,
          profile_path: "/ec.jpg",
        },
        {
          id: 2,
          name: "Kit Harington",
          roles: [{ character: "Jon Snow", episode_count: 73 }],
          total_episode_count: 73,
          order: 3,
          profile_path: "/kh.jpg",
        },
      ],
    };
    assert.deepEqual(pickTopCast(credits), [
      { name: "Kit Harington", character: "Jon Snow", profilePath: "/kh.jpg" },
      { name: "Emilia Clarke", character: "Daenerys Targaryen", profilePath: "/ec.jpg" },
    ]);
  });

  it("caps at the limit and drops entries past it", () => {
    const cast = Array.from({ length: 12 }, (_, i) => ({
      id: i,
      name: `Actor ${i}`,
      character: `Role ${i}`,
      profile_path: null,
      order: i,
    }));
    assert.equal(pickTopCast({ cast }).length, 8);
    assert.equal(pickTopCast({ cast }, 3).length, 3);
    assert.deepEqual(
      pickTopCast({ cast }, 2).map((c) => c.name),
      ["Actor 0", "Actor 1"],
    );
  });

  it("defaults missing character/profile and drops nameless rows", () => {
    const credits = {
      cast: [
        { id: 1, name: "Someone", order: 0 },
        { id: 2, name: "", character: "Ghost", order: 1 },
      ],
    };
    assert.deepEqual(pickTopCast(credits), [
      { name: "Someone", character: "", profilePath: null },
    ]);
  });

  it("returns [] for empty input and does not mutate the caller's array", () => {
    assert.deepEqual(pickTopCast(undefined), []);
    assert.deepEqual(pickTopCast({}), []);
    const cast = [
      { id: 1, name: "B", order: 1 },
      { id: 2, name: "A", order: 0 },
    ];
    pickTopCast({ cast });
    assert.deepEqual(
      cast.map((c) => c.name),
      ["B", "A"],
    );
  });
});

describe("pickDirector", () => {
  it("returns crew members whose job is Director", () => {
    const credits = {
      crew: [
        { id: 1, name: "David Fincher", job: "Director", department: "Directing" },
        { id: 2, name: "Arnon Milchan", job: "Executive Producer", department: "Production" },
      ],
    };
    assert.deepEqual(pickDirector(credits), ["David Fincher"]);
  });

  it("supports co-directors and de-dupes repeated credits", () => {
    const credits = {
      crew: [
        { id: 1, name: "Joel Coen", job: "Director" },
        { id: 2, name: "Ethan Coen", job: "Director" },
        { id: 1, name: "Joel Coen", job: "Director" },
      ],
    };
    assert.deepEqual(pickDirector(credits), ["Joel Coen", "Ethan Coen"]);
  });

  it("returns [] when there is no director", () => {
    assert.deepEqual(pickDirector({ crew: [{ name: "X", job: "Writer" }] }), []);
    assert.deepEqual(pickDirector(undefined), []);
  });
});

describe("pickCreators", () => {
  it("uses created_by names when present", () => {
    const createdBy = [
      { id: 9813, name: "David Benioff" },
      { id: 228068, name: "D. B. Weiss" },
    ];
    assert.deepEqual(pickCreators(createdBy), ["David Benioff", "D. B. Weiss"]);
  });

  it("falls back to aggregate crew with a Creator job", () => {
    const crew = [
      { id: 1, name: "Deborah Riley", jobs: [{ job: "Production Design" }] },
      { id: 2, name: "Vince Gilligan", jobs: [{ job: "Creator" }] },
    ];
    assert.deepEqual(pickCreators(undefined, crew), ["Vince Gilligan"]);
    assert.deepEqual(pickCreators([], crew), ["Vince Gilligan"]);
  });

  it("prefers created_by over the crew fallback", () => {
    const createdBy = [{ id: 1, name: "Real Creator" }];
    const crew = [{ id: 2, name: "Crew Creator", jobs: [{ job: "Creator" }] }];
    assert.deepEqual(pickCreators(createdBy, crew), ["Real Creator"]);
  });

  it("returns [] when nothing matches", () => {
    assert.deepEqual(pickCreators(undefined, undefined), []);
    assert.deepEqual(
      pickCreators([], [{ name: "X", jobs: [{ job: "Writer" }] }]),
      [],
    );
  });
});

describe("imdbUrl", () => {
  it("builds the canonical URL when imdb_id is present", () => {
    assert.equal(
      imdbUrl({ imdb_id: "tt0137523" }),
      "https://www.imdb.com/title/tt0137523/",
    );
  });

  it("returns null when imdb_id is missing, null, or blank", () => {
    assert.equal(imdbUrl({ imdb_id: null }), null);
    assert.equal(imdbUrl({ imdb_id: "" }), null);
    assert.equal(imdbUrl({}), null);
    assert.equal(imdbUrl(undefined), null);
  });
});
