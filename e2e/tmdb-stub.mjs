// A stand-in for the TMDB API during the end-to-end suite. The server reaches
// it through TMDB_API_BASE_URL (see src/lib/tmdb.ts) and gets canned JSON for
// exactly the endpoints the tested flows call. Anything else is logged and
// answered 404, so a flow that starts calling a new endpoint fails loudly.
// Every image path is null, so the browser never asks image.tmdb.org for one.
import { createServer } from "node:http";

const port = Number(process.env.TMDB_STUB_PORT ?? 3101);

const empty = { page: 1, results: [], total_pages: 0, total_results: 0 };
const genres = [{ id: 18, name: "Drama" }];

const movie = {
  id: 910001,
  title: "Lantern Road",
  original_title: "Lantern Road",
  overview: "A night courier takes one last delivery.",
  release_date: "2021-03-05",
  poster_path: null,
  backdrop_path: null,
  vote_average: 7.1,
  original_language: "en",
  runtime: 104,
  genres,
};

const episode = (id, number, airDate) => ({
  id,
  episode_number: number,
  season_number: 1,
  name: `Episode ${number}`,
  overview: "",
  air_date: airDate,
  runtime: 45,
  still_path: null,
  vote_average: 7,
});

// Two shows: the undo spec takes the second on a retry, since its first
// attempt may have left the first one marked watched.
const tvShow = (id, name) => ({
  id,
  name,
  original_name: name,
  overview: "A radio station at the edge of the map.",
  first_air_date: "2020-01-10",
  poster_path: null,
  backdrop_path: null,
  vote_average: 7.8,
  original_language: "en",
  episode_run_time: [],
  number_of_seasons: 1,
  number_of_episodes: 2,
  genres,
  status: "Ended",
  next_episode_to_air: null,
  last_episode_to_air: null,
  created_by: [],
  seasons: [
    {
      id: id + 100,
      season_number: 1,
      name: "Season 1",
      overview: "",
      air_date: "2020-01-10",
      poster_path: null,
      episode_count: 2,
    },
  ],
});
const shows = [tvShow(920001, "Northern Static"), tvShow(930001, "Southern Static")];

const provider = {
  provider_id: 8,
  provider_name: "Stub Stream",
  logo_path: null,
  display_priority: 1,
};

const routes = {
  "/search/multi": (query) => {
    const q = (query.get("query") ?? "").toLowerCase();
    const results = [
      { ...movie, media_type: "movie" },
      ...shows.map((show) => ({ ...show, media_type: "tv" })),
    ].filter((item) => (item.title ?? item.name).toLowerCase().includes(q));
    return { ...empty, results, total_pages: 1, total_results: results.length };
  },
  // Adding the movie. The movie spec never opens its title page.
  [`/movie/${movie.id}`]: () => movie,
  // One response for every append_to_response the flows send: the add flow's
  // season/1 and the title page's bundle (with nothing to show), whose empty
  // recommendations make the page ask for /similar.
  ...Object.fromEntries(
    shows.flatMap((show) => [
      [
        `/tv/${show.id}`,
        () => ({
          ...show,
          videos: { results: [] },
          "watch/providers": { results: {} },
          recommendations: empty,
          external_ids: { imdb_id: null },
          aggregate_credits: { cast: [], crew: [] },
          content_ratings: { results: [] },
          "season/1": {
            season_number: 1,
            name: "Season 1",
            overview: "",
            air_date: "2020-01-10",
            poster_path: null,
            episodes: [
              episode(show.id + 110, 1, "2020-01-10"),
              episode(show.id + 111, 2, "2020-01-17"),
            ],
          },
        }),
      ],
      [`/tv/${show.id}/similar`, () => empty],
    ]),
  ),
  "/watch/providers/regions": () => ({
    results: [
      { iso_3166_1: "DE", english_name: "Germany" },
      { iso_3166_1: "GB", english_name: "United Kingdom" },
      { iso_3166_1: "US", english_name: "United States" },
    ],
  }),
  "/watch/providers/movie": () => ({ results: [provider] }),
  "/watch/providers/tv": () => ({ results: [provider] }),
};

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json;charset=utf-8" });
  res.end(JSON.stringify(body));
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  if (!req.headers.authorization?.startsWith("Bearer ")) {
    console.error(`[tmdb-stub] 401 (no Bearer token) ${req.method} ${req.url}`);
    return send(res, 401, { success: false, status_code: 7, status_message: "Invalid API key." });
  }
  const route = req.method === "GET" ? routes[url.pathname] : undefined;
  if (!route) {
    console.error(`[tmdb-stub] 404 (no stub) ${req.method} ${req.url}`);
    return send(res, 404, {
      success: false,
      status_code: 34,
      status_message: "The resource you requested could not be found.",
    });
  }
  send(res, 200, route(url.searchParams));
}).listen(port, "127.0.0.1", () => {
  console.log(`[tmdb-stub] listening on http://127.0.0.1:${port}`);
});
