import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "./server-only-shim";

// Settings' Account activity (BA-15): the labels, the rendered list and how
// the page feeds it.

const { AUTH_EVENT_TYPES } = await import("../src/lib/auth-events");
const { authEventLabel } = await import("../src/lib/auth-event-labels");
const { AccountActivitySection } = await import(
  "../src/app/(app)/settings/account-activity-section"
);

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

function render(props: Parameters<typeof AccountActivitySection>[0]) {
  return renderToStaticMarkup(createElement(AccountActivitySection, props));
}

describe("auth event labels", () => {
  it("names every event type in sentence case", () => {
    assert.deepEqual(
      Object.fromEntries(AUTH_EVENT_TYPES.map((type) => [type, authEventLabel(type)])),
      {
        sign_in: "Signed in",
        sign_out: "Signed out",
        password_changed: "Changed password",
        two_factor_enabled: "Turned on 2FA",
        two_factor_disabled: "Turned off 2FA",
        two_factor_secret_replaced: "Replaced the 2FA key and backup codes",
        backup_codes_regenerated: "Made new backup codes",
        session_revoked: "Signed out a device",
        other_sessions_revoked: "Signed out everywhere else",
        all_sessions_revoked: "Signed out everywhere",
      },
    );
    for (const type of AUTH_EVENT_TYPES) {
      assert.match(authEventLabel(type), /^[A-Z][a-z]*(?: (?:[a-z]+|2FA))*$/, type);
    }
  });

  it("gives a type this build doesn't know a generic label, prototype keys included", () => {
    for (const type of ["password_reset", "", "toString", "constructor", "__proto__"]) {
      assert.equal(authEventLabel(type), "Account change", type);
    }
  });
});

describe("Account activity section", () => {
  const events = [
    {
      id: "e2",
      type: "session_revoked",
      ipAddress: null,
      userAgent: null,
      createdAt: "2026-09-27T23:17:00.000Z",
    },
    {
      id: "e1",
      type: "sign_in",
      ipAddress: "192.0.2.10",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1",
      createdAt: "2026-09-27T09:05:00.000Z",
    },
  ];

  it("lists each event's label, time in the account's zone, device and IP, in order", () => {
    const html = render({ events, timeZone: "America/New_York" });
    assert.match(html, /<h2[^>]*>Account activity<\/h2>/);
    assert.match(html, /Times are in America\/New_York\./);
    const rows = html.match(/<li[^>]*>.*?<\/li>/g) ?? [];
    assert.equal(rows.length, 2);
    // \s also folds the narrow no-break space some ICU builds put before "PM".
    const text = rows.map((row) => row.replace(/<[^>]+>/g, "").replace(/\s+/g, " "));
    assert.deepEqual(text, [
      "Signed out a deviceSep 27, 2026, 7:17 PM · Unknown device · IP unavailable",
      "Signed inSep 27, 2026, 5:05 AM · Safari on iPhone · IP 192.0.2.10",
    ]);
    assert.match(rows[1], /<time dateTime="2026-09-27T09:05:00.000Z">/);
  });

  it("falls back to UTC for a zone Intl rejects", () => {
    const html = render({ events: events.slice(1), timeZone: "Not/AZone" });
    assert.match(html, />Sep 27, 2026, 9:05\sAM</);
  });

  it("says so when there is nothing yet, or when the list couldn't be read", () => {
    assert.match(render({ events: [], timeZone: "UTC" }), /<p class="text-sm text-muted">No account activity yet\.<\/p>/);
    const failed = render({ events: null, timeZone: "UTC" });
    assert.match(failed, /role="alert"/);
    assert.match(failed, /Celluloid couldn(?:&#x27;|')t load your account activity\. Reload the page to try again\./);
  });
});

describe("Account activity wiring", () => {
  it("reuses the Devices user-agent parser instead of copying it", async () => {
    const [section, devices] = await Promise.all([
      source("../src/app/(app)/settings/account-activity-section.tsx"),
      source("../src/app/(app)/settings/devices-section.tsx"),
    ]);
    assert.match(section, /import \{ deviceLabel \} from "\.\/devices-section";/);
    assert.doesNotMatch(section, /function deviceLabel/);
    assert.match(devices, /export function deviceLabel\(/);
  });

  it("sits right after Devices and gets the account's zone", async () => {
    const client = await source("../src/app/(app)/settings/settings-client.tsx");
    assert.match(
      client,
      /<DevicesSection [^>]*\/>\s*<\/div>\s*<div className="lg:col-span-2">\s*<AccountActivitySection events=\{authEvents\} timeZone=\{timeZone\} \/>/,
    );
  });

  it("loads the signed-in user's events on the server", async () => {
    const page = await source("../src/app/(app)/settings/page.tsx");
    assert.match(page, /const user = await requireUser\(\);/);
    assert.match(page, /getRecentAuthEvents\(user\.id\),\n {2}\]\);/);
    assert.match(page, /authEvents=\{authEvents\}/);
  });
});
