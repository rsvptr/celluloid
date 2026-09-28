import type { Page } from "@playwright/test";
import { expect, gotoHydrated, test } from "./fixtures";

// Titles served by e2e/tmdb-stub.mjs.
const MOVIE = { query: "Lantern", name: "Lantern Road (Movie, 2021)" };
const SHOW = { query: "Northern", name: "Northern Static (TV, 2020)" };

/** Searches TMDB from the Add page and adds one result; returns its library link. */
async function addFromSearch(page: Page, title: { query: string; name: string }) {
  await gotoHydrated(page, "/add");
  await page.getByRole("searchbox", { name: "Search The Movie Database" }).fill(title.query);
  await page.getByRole("button", { name: `Add ${title.name} to your library` }).click();
  const link = page.getByRole("link", { name: `View ${title.name} in your library` });
  await expect(link).toBeVisible();
  return link;
}

test("add a movie from search and find it in the library", async ({ page }) => {
  await addFromSearch(page, MOVIE);

  await gotoHydrated(page, "/");
  await expect(page.getByRole("link", { name: "Lantern Road", exact: true })).toBeVisible();
});

// Only a TV title's Mark watched offers Undo: undoing it unticks the episodes
// the mark ticked. A movie has none.
test("mark a show watched, then undo it from the toast", async ({ page }) => {
  await (await addFromSearch(page, SHOW)).click();
  await expect(page.getByRole("heading", { name: "Northern Static" })).toBeVisible();

  const status = page.getByRole("combobox", { name: "Status" });
  const watchedDate = page.getByRole("group", { name: "Date watched" }).getByLabel("Date watched");
  await expect(status).toHaveValue("WATCHLIST");
  await expect(watchedDate).toHaveValue("");

  await status.selectOption("WATCHED");
  await expect(page.getByText("Marked watched")).toBeVisible();
  await expect(watchedDate).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Watched change undone")).toBeVisible();
  await expect(status).toHaveValue("WATCHLIST");
  await expect(watchedDate).toHaveValue("");

  // Saved, not just shown.
  await page.reload();
  await expect(status).toHaveValue("WATCHLIST");
  await expect(watchedDate).toHaveValue("");
});
