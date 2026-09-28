import { test as base, expect, type Page } from "@playwright/test";

/** The server's SIGNUP_INVITE_CODE (playwright.config.ts). Not a secret. */
export const INVITE_CODE = "e2e-invite-code-not-a-secret";

/** Where the auth spec leaves its signed-in session for the other specs. */
export const STORAGE_STATE = "e2e/.auth/user.json";

/**
 * Specs use this `test`: its page aborts, and then fails the test on, any
 * request that leaves the app. The TMDB stub has no images and the fonts are
 * self-hosted, so the browser has no reason to reach anything else.
 */
export const test = base.extend({
  // The fixture callback is named `provide`, not Playwright's usual `use`, so
  // the React hooks lint rule doesn't take it for React's use().
  page: async ({ page, baseURL }, provide) => {
    const origin = new URL(baseURL!).origin;
    const external: string[] = [];
    await page.route(
      (url) => url.origin !== origin,
      (route) => {
        external.push(route.request().url());
        return route.abort();
      },
    );
    await provide(page);
    expect(external, "requests outside the app").toEqual([]);
  },
});

/**
 * page.goto, then waits until React has hydrated the page: the root layout's
 * HydrationMarker sets `data-hydrated` on <html>. A click, fill, option change
 * or Enter before then can miss React's handlers, so every page's first
 * interaction comes after this.
 */
export async function gotoHydrated(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
}

export { expect };
