import { expect, gotoHydrated, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await gotoHydrated(page, "/settings");
});

test("a changed time zone survives a reload", async ({ page }) => {
  const timeZone = page.getByRole("combobox", { name: "Time zone" });
  const target = (await timeZone.inputValue()) === "Europe/Berlin" ? "Asia/Tokyo" : "Europe/Berlin";
  await timeZone.selectOption(target);
  // Preferences' own Save, not Profile's: the innermost block that holds both
  // the time zone and a Save button.
  const save = page.getByRole("button", { name: "Save", exact: true });
  const preferences = page.locator("div").filter({ has: timeZone }).filter({ has: save }).last();
  await preferences.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Preferences saved." })).toBeVisible();

  await page.reload();
  await expect(timeZone).toHaveValue(target);
  await expect(page.getByText(`Times are in ${target}.`)).toBeVisible();
});

test("a new display name shows in the header without a reload", async ({ page }) => {
  const name = `E2E Renamed ${Date.now()}`;
  // A full page load would drop this.
  await page.evaluate(() => Reflect.set(window, "e2eSamePage", true));
  const field = page.getByRole("textbox", { name: "Display name" });
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
