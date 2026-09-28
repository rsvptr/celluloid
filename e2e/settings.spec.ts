import { expect, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.goto("/settings");
});

test("a changed time zone survives a reload", async ({ page }) => {
  const timeZone = page.getByRole("combobox", { name: "Time zone" });
  const target = (await timeZone.inputValue()) === "Europe/Berlin" ? "Asia/Tokyo" : "Europe/Berlin";
  await timeZone.selectOption(target);
  // Profile's Save stays disabled until the display name changes, which
  // leaves Preferences' Save as the only enabled one.
  await page.getByRole("button", { name: "Save", exact: true, disabled: false }).click();
  await expect(page.getByRole("status").filter({ hasText: "Preferences saved." })).toBeVisible();

  await page.reload();
  await expect(timeZone).toHaveValue(target);
  await expect(page.getByText(`Times are in ${target}.`)).toBeVisible();
});

test("a new display name shows in the header without a reload", async ({ page }) => {
  const name = `E2E Renamed ${Date.now()}`;
  // A full page load would drop this.
  await page.evaluate(() => Reflect.set(window, "e2eSamePage", true));
  const field = page.getByLabel("Display name");
  await field.fill(name);
  await field.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Profile saved." })).toBeVisible();
  await expect(page.getByRole("banner").getByText(name)).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "e2eSamePage"))).toBe(true);
});

test("account activity lists the sign-up, sign-out and sign-in", async ({ page }) => {
  // auth.spec.ts made this account's only auth events. Newest first.
  const events = page.getByRole("listitem").filter({ hasText: /^Signed (in|out)/ });
  await expect(events).toHaveText([/^Signed in/, /^Signed out/, /^Signed in/]);
});
