import { expect, INVITE_CODE, STORAGE_STATE, test } from "./fixtures";

// Runs before every other spec (the "auth" project) and leaves its session in
// STORAGE_STATE for them, so a run creates one account. Better Auth allows 5
// sign-up requests a minute per IP; this spec makes 2 (the rejected one counts).
test("sign up with the invite code, sign out, and sign in again", async ({ page }) => {
  const name = "E2E Tester";
  const email = `e2e-${Date.now()}@example.test`;
  const password = "e2e-password-not-secret";

  await page.goto("/login");
  await page.getByRole("button", { name: "Create one" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Invite code", { exact: true }).fill("not-the-invite-code-0000");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  // Filtered: Next's route announcer is an (empty) alert too.
  await expect(page.getByRole("alert").filter({ hasText: "invite code" })).toHaveText(
    "That invite code wasn't accepted. Ask the person who invited you for a new one.",
  );
  await expect(page).toHaveURL("/login");

  await page.getByLabel("Invite code", { exact: true }).fill(INVITE_CODE);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByText("Your library is empty.")).toBeVisible();
  await expect(page.getByRole("banner").getByText(name)).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/login");
  // The session is gone, not just the page: the app sends a signed-out visitor back.
  await page.goto("/");
  await expect(page).toHaveURL("/login");

  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("banner").getByText(name)).toBeVisible();

  await page.context().storageState({ path: STORAGE_STATE });
});
