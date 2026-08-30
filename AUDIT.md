# Celluloid — Pre-sharing Audit

> **Remediation status (2026-08-29, end of day):** COMPLETE for all delegated work. All 10 Codex tasks (T1–T10) and 5 Sonnet batches (B-SON-1…5) are DONE, each reviewed by Fable with an independently verified green gate (final: 371/371 tests, tsc, lint, prod build). Every finding routed in the delegation plan below is fixed. Both migrations (`20260829214500_add_shared_ai_daily_usage`, `20260830095500_add_session_account_userid_indexes` — API-8) are **applied to the dev database** (2026-08-30); prod receives them on the next deploy. SEC-4 done (next 16.3.3, advisories 11→3; remainder is the deepmerge-ts build-tooling chain fixable only by a prisma major downgrade — deliberately left). LOGIC-10 done per D-011 (T11). Work is committed at `2ca4f34` + `f22b6c8`. Remaining owner actions are deploy-time only: set `SIGNUP_INVITE_CODE` and (optionally) `SHARED_AI_DAILY_RUN_LIMIT` in Vercel, verify `DIRECT_URL` and the Node version pin there, then deploy — the production build runs `prisma migrate deploy` automatically. See `.agent-collaboration/TASKS.md` for per-task review notes.

**Date:** 2026-08-29 · **Auditor:** Fable 5 (orchestrator) with 5 Fable subagent audits + Sonnet toolchain verification
**Goal:** harden the app enough to share with a few friends — stability, per-user isolation, session tracking/deauth, cost safety.
**DB context:** dev DB connected; prod exists. Not a SaaS — friends-scale multi-user.

## Verdict at a glance

| Category | State | Critical | High | Medium | Low |
| --- | --- | --- | --- | --- | --- |
| Security / Auth / Multi-user | ✅ audited | 1 (resolved) | 1 | 3 | 2 |
| API / Data layer | ✅ audited | 0 | 0 (dup of resolved critical) | 2 | 6 |
| Business logic | ✅ audited | 0 | 0 | 4 | 9 |
| UI/UX / Accessibility | ✅ audited | 0 | 0 | 4 | 13 |
| Reliability / Ops / Deployment | ✅ audited | 0 | 1 | 4 | 4 |
| Performance | ✅ audited | 0 | 0 | 3 | 6 |
| Recommend-tab deep-dive (owner symptom) | ✅ audited | 0 | 0 | 5 | 5 |
| Toolchain (tsc/lint/tests) | ✅ all green | 0 | 0 | 0 | 1 |

**Headline:** the foundations are genuinely strong — per-user data isolation is complete and verified (a friend signing up gets an empty, private library; no cross-user read/write path found), every API route is authenticated, share links / upload hardening / CSP / TMDB integration are well built, and the toolchain is fully green (tsc, lint, 331/331 tests). Zero unresolved criticals and one high per lane at most. The gaps are a thin layer on top: a Devices/sessions UI, signup gating, cost controls, prod error-message surfacing, env-file convention unification, and a handful of stream-robustness fixes in the recommend tab that together explain the owner's "AI slow or dead" symptom (ranked diagnosis in the deep-dive section).

**Audit complete: 7 lanes, 5 mediums and below only in most lanes, 2 highs total (SEC-1 sessions UI, OPS-1 env split-brain), 1 critical (secrets in env.example — resolved during audit).**

---

## RESOLVED during audit

### ✅ [was SEV-critical] Live secrets in tracked `env.example`
- **Where:** `env.example` working tree (was modified; committed version always had placeholders — verified against full git history)
- **What:** Real dev+prod Neon URLs, TMDB token, Anthropic key, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `CRON_SECRET` had been filled into the tracked example file — one `git commit -a` from leaking into history. Found independently by both wave-1 auditors.
- **Action taken:** values copied to `.env.local` (gitignored, hash-verified identical), `env.example` restored to committed placeholders via `git restore`.
- **Decision (owner):** no rotation needed — values are temporary dev credentials; nothing was ever committed or exposed.
- **Optional follow-up:** add a gitleaks/pre-commit secret scan given the near-miss. (Effort S)

---

## Findings — Security / Auth / Multi-user

### [SEV-high] SEC-1 · No way to list or revoke login sessions per device — only the UI is missing
- **Where:** gap in `src/app/(app)/settings/settings-client.tsx` (no Devices section; only `revokeOtherSessions: true` on password change at :1358). Backend already complete: better-auth 1.6.23 ships `authClient.listSessions()` / `revokeSession({token})` / `revokeOtherSessions()` / `revokeSessions()`, endpoints already mounted via `src/app/api/auth/[...all]/route.ts:4`; `Session` table already stores `ipAddress`, `userAgent`, timestamps (`prisma/schema.prisma:150-162`); 60s cookie cache (`src/lib/auth.ts:83-89`) means revocation bites fast.
- **Impact:** the owner's explicit requirement — see active logins per device and kick one — is unmet. A friend's lost phone or stolen cookie can't be inspected or killed except by password change or manual DB surgery.
- **Fix:** add a "Devices" section to Settings: list sessions (device label parsed from userAgent, IP, last-active, current-session marker), per-session revoke button, "sign out everywhere else" button. Client component only; no server code needed.
- **Effort:** S–M · **Route:** Codex

### [SEV-medium] SEC-2 · Signup gating is all-or-nothing
- **Where:** `src/lib/auth.ts:26-35` (`ALLOW_SIGNUPS==="true"` or legacy `DISABLE_SIGNUPS==="false"` opens `/api/auth/sign-up/email` to anyone), `:47` (`requireEmailVerification: false`), `env.example:46` ships `ALLOW_SIGNUPS="true"` as the example default.
- **Impact:** during an invite window, strangers who find the URL can register and get the full feature set (incl. AI recommendations billed to the deployment key). Data isolation holds, so this is resource/abuse exposure, not data exposure.
- **Fix options (owner decision):** (a) cheapest — coordinated signup window, then unset the var and verify with an incognito signup attempt; (b) better — keep signups closed permanently and create friend accounts server-side (better-auth admin `createUser` or a one-off script); (c) invite token checked in a better-auth `before` hook. Also remove `ALLOW_SIGNUPS="true"` as the example default and drop the deprecated `DISABLE_SIGNUPS` back-compat.
- **Effort:** S (a) / M (b, c) · **Route:** owner decision → Codex

### [SEV-medium] SEC-3 · Any user can bill the owner's Anthropic key; no durable spend cap
- **Where:** `src/lib/anthropic.ts:38` (fallback to deployment `ANTHROPIC_API_KEY` for users without their own), `src/app/api/recommend/route.ts:60` (10 runs/min/user — but in-memory, resets per instance, `src/lib/rate-limit.ts:1-6`), up to 30 titles/run (`src/lib/recommend.ts:566`).
- **Impact:** a friend can run recommendations continuously on the owner's key; no daily/monthly budget, no owner/guest distinction.
- **Fix options (owner decision):** (a) require non-owner accounts to bring their own key (branch on the existing fallback detection; return "add your key in Settings"); (b) durable per-user daily counter in Postgres (mirror the better-auth `rateLimit` table pattern, `schema.prisma:201-208`); plus set a spend limit on the key in the Anthropic console as backstop.
- **Effort:** S (a) / M (b) · **Route:** owner decision → Codex

### [SEV-medium] SEC-4 · Known-vulnerable transitive dependencies; fix is a patch-level Next bump
- **Where:** `package.json:41` (`next: 16.2.12` — bundled postcss ≤8.5.22 GHSA-fxqj-rqcc-2cmp, bundled sharp <0.35.0 libvips CVEs; fixed in 16.3.3), `package.json:66-71` (`@hono/node-server ^1.19.13` override resolves below the 1.19.15 fix for GHSA-frvp-7c67-39w9). npm audit: 9 high, 4 moderate, 0 critical — mostly build-time/tooling exposure.
- **Fix:** bump `next` → 16.3.3, raise `@hono/node-server` override → `^1.19.15`, `npm audit fix`, re-run tests.
- **Effort:** S · **Route:** Sonnet (mechanical) + verification

### [SEV-low] SEC-5 · App-route rate limiting is per-instance memory (documented decision D-004)
- **Where:** `src/lib/rate-limit.ts:1-6`; auth endpoints are NOT affected (DB-backed better-auth limiter, `src/lib/auth.ts:65-79`).
- **Fix:** only if abuse observed — durable store (Upstash/KV or the DB pattern) for recommend/backup/share keys. **Route:** defer

### [SEV-low] SEC-6 · Password policy length-only; 2FA optional
- **Where:** `src/lib/auth.ts:48` (`minPasswordLength: 10`); brute force well damped by DB-backed limits.
- **Fix:** optional — raise to 12, nudge invited friends toward the existing 2FA during onboarding. **Route:** defer / fold into SEC-2 onboarding copy

---

## Findings — API / Data layer

### [SEV-medium] API-1 · Thrown server-action error messages are redacted in production — toasts show boilerplate
- **Where:** ~half the server actions `throw new Error("…")` — `src/lib/actions.ts:147, 152, 284, 405, 624, 695, 759, 814, 890, 1524, 1603, 1643-1662, 1677`; clients render `(e as Error).message` (`src/components/library.tsx:953, 997, 1436, 1459, 1484`, `title-controls.tsx:235`, `season-tracker.tsx:298`). Next.js masks Server Action error messages in prod builds. The other half of actions already use the `{ error }` return contract.
- **Impact:** in prod, "You already have a tag called X", "You're signed out…", bulk-cap messages etc. all collapse into generic boilerplate. Invisible in dev.
- **Fix:** convert throwing actions to the `{ error }` contract (mechanical; ~5 client call sites adjust), or a wrapper that catches known-safe errors and returns `{ error }`. Any reworded user-facing copy goes through the humanizer skill.
- **Effort:** M · **Route:** Codex

### [SEV-medium] API-2 · Import commit chunk has no wall-clock budget — can die mid-batch at `maxDuration = 60`
- **Where:** `src/lib/import-staging.ts:891-934` (20-item batches, no deadline check — unlike staging's 35s budget at :53); route `src/app/api/import/jobs/[jobId]/commit/route.ts`. TV-heavy batches with cold TMDB cache can exceed 60s.
- **Impact:** function killed mid-batch; job stalls in `COMMITTING` until the owner presses Commit again (recoverable — per-item writes transactional — but confusing).
- **Fix:** thread a `deadlineAt` (request start + 45s) into `commitImportJobChunk`, stop starting items past it, return partial batch — same pattern staging and cron sync already use.
- **Effort:** S · **Route:** Codex (bundle with import-adjacent fixes)

### [SEV-low] API-3 · Provider-only sync failures never stamped → failing titles pin the nightly queue head
- **Where:** `src/lib/metadata-sync.ts:1038-1049` (failure stamp gated on `TV_METADATA` kind); queue orders `providersSyncedAt: null` first (:359-393).
- **Fix:** stamp `providersSyncedAt` (or an error marker) on provider-only failure so the row rotates. **Effort:** S · **Route:** Sonnet

### [SEV-low] API-4 · Backup export can silently exceed the restore route's 4MB cap
- **Where:** `src/app/api/backup/route.ts:19-27` (no size check) vs `MAX_BACKUP_BYTES = 4MB` enforced at restore (`src/app/api/backup/restore/route.ts:44-59`). Discovered only during disaster recovery.
- **Fix:** warn at export time when near/over the cap (or gzip the envelope / raise restore cap). **Effort:** S · **Route:** Codex (touches recovery semantics — review carefully)

### [SEV-low] API-5 · `updateWatchEvent` erases the note when callers omit it
- **Where:** `src/lib/actions.ts:545-581` (optional `note` written unconditionally; omitted → `null`). No user-visible bug today (UI always sends the draft), but a loaded API contract.
- **Fix:** include `note` in update data only when `!== undefined`, mirroring `updateTitle` (:340-349). **Effort:** S · **Route:** Sonnet

### [SEV-low] API-6 · Vercel-build migrations can silently run through the Neon pooler
- **Where:** `prisma.config.ts:13-16` (`DIRECT_URL ?? DATABASE_URL`), `package.json` vercel-build; the manual prod script warns on `-pooler.` hosts but the Vercel path doesn't; `env.ts` never validates `DIRECT_URL`. (UNVERIFIED whether the Vercel project sets `DIRECT_URL`.)
- **Fix:** in vercel-build (production), warn/fail if `DIRECT_URL` unset and `DATABASE_URL` contains `-pooler.`. **Effort:** S · **Route:** Sonnet + owner checks Vercel env
- **Owner action:** confirm `DIRECT_URL` is set in the Vercel project.

### [SEV-low] API-7 · `recommendRequestSchema` exported from a route file
- **Where:** `src/app/api/recommend/route.ts:19-45` — dead export; route files should export only handlers/config.
- **Fix:** make it module-local or move next to `RecommendOptions`. **Effort:** S · **Route:** Sonnet

### [SEV-low] API-8 · `Session.userId` / `Account.userId` FKs unindexed
- **Where:** `prisma/schema.prisma:150-181`. Unmeasurable today; cheap insurance (session listing/revocation queries by userId — relevant once SEC-1 ships).
- **Fix:** `@@index([userId])` on both in a follow-up migration. **Effort:** S · **Route:** Codex (migration → needs owner approval before deploy)

---

## Findings — UI/UX / Accessibility

No critical or high findings. The auditor's note: "one of the strongest first-run/a11y showings I've audited."

### [SEV-medium] UI-1 · Episode toggles roll back silently on failure
- **Where:** `src/app/(app)/title/[id]/season-tracker.tsx:177-187, 202-216, 226-239` — optimistic rollback with no toast (contrast `watchThrough` :292-299 which toasts).
- **Impact:** on a flaky connection a tick silently unticks; user believes progress saved when it wasn't.
- **Fix:** one coalesced error toast per failed drain. **Effort:** S · **Route:** Sonnet

### [SEV-medium] UI-2 · Settings backup download revokes its object URL in the same tick
- **Where:** `settings-client.tsx:1740-1747` vs `export-panel.tsx:438-453`, which documents and guards this exact race with a deferred revoke.
- **Impact:** in affected browsers the backup download can fail silently while the UI toasts "Backup downloaded" and stamps freshness — the one line meant to be trustworthy.
- **Fix:** extract export-panel's `saveBlob` to a shared module; reuse in `downloadBackup`. **Effort:** S · **Route:** Sonnet

### [SEV-medium] UI-3 · Command palette stuck on "Loading your titles…" when the index fetch fails
- **Where:** `src/components/command-palette.tsx:133-148` (`.catch(() => {})`), :253-255.
- **Fix:** track `loadError` + inline retry (pattern exists in `recommend-client.tsx:1151-1168`). **Effort:** S · **Route:** Sonnet

### [SEV-medium] UI-4 · `<details>` disclosures render no expand/collapse indicator
- **Where:** `recommend-client.tsx:621-627, 758-764`, `suppressions-panel.tsx:88-93` — `display:flex` on `<summary>` removes the native marker; no chevron drawn (unlike library.tsx:1052-1057, settings-client.tsx:979-983).
- **Impact:** "Tune results", "Model & cost", "Not interested" read as static rows — first-time users never find the filters.
- **Fix:** add the same rotating `ChevronDown` used elsewhere. **Effort:** S · **Route:** Sonnet

### SEV-low (UI-5 … UI-17) — polish batch
| # | Item | Where | Fix |
| --- | --- | --- | --- |
| UI-5 | Bulk-bar "Set status…" select unnamed for AT | `library.tsx:1027-1042` | `aria-label` |
| UI-6 | Empty-library Export page blames "filters", no CTA | `export-panel.tsx:427-429` | zero-state with link to `/add` |
| UI-7 | Stats empty-state links both go to bare `/` | `stats-client.tsx:51-64` | deep-link to `/?status=…` filters |
| UI-8 | Date-format drift (en-GB expiry, viewer-locale heatmap, ISO aria-labels) | `settings-client.tsx:874-881`, `activity-calendar.tsx:19-27, 236-237` | use `fullDate` / `readableDay` |
| UI-9 | Sign-out: no failure feedback or pending state | `nav.tsx:72-76` | try/catch + toast |
| UI-10 | Favorite state invisible to assistive tech | `title-card.tsx:106-111`, `library.tsx:1267` | sr-only "Favorite" |
| UI-11 | Dead share links 404 into a login wall for anonymous friends | `s/[slug]/page.tsx:86`, `not-found.tsx` | add `s/[slug]/not-found.tsx` with visitor copy (humanizer) |
| UI-12 | Decade-chart labels can collide at 320px (UNVERIFIED) | `charts.tsx:63-84` | thin/rotate labels when buckets > 8 |
| UI-13 | BarRow labels truncate with no recovery | `charts.tsx:24-26` | `title={label}` |
| UI-14 | Settings credential sections aren't `<form>`s (Enter doesn't submit; password managers less reliable) | `settings-client.tsx:1315-1381, 199-252, 2101-2173` | wrap in forms, `type="submit"` |
| UI-15 | Unused `ActivityHeatmap` dead code + duplicated level scale | `charts.tsx:237-296` | remove in housekeeping |
| UI-16 | Export prompt says "ABANDONED" where UI says "Dropped" | `src/lib/export/format.ts:454-459` | "DROPPED / didn't finish (…)" (humanizer) |
| UI-17 | `(app)` errors drop the nav shell (no route-group error.tsx) | `src/app/error.tsx` only | add `src/app/(app)/error.tsx` |

Deferred (not actionable now): full library ships to client per `/` render — fine at current scale, revisit past ~2k titles (`page.tsx:33-41`, mitigations already in place).

---

## Findings — Business logic

### [SEV-medium] LOGIC-1 · Same TMDB title can be recommended twice in one run
- **Where:** `src/lib/recommend.ts:803-810` (dedupe runs pre-enrichment only; `enrichRec` :396-461 never records the resolved identity); duplicate React key risk at `recommend-client.tsx:892`.
- **What:** Two model suggestions with claimed years off by one ("The Thing" 1982 vs 1983) have different dedupe keys, both resolve to the same TMDB id, and both are emitted — duplicate cards, wasted count slot, wasted TMDB search.
- **Fix:** after `pickBest` resolves, check-and-insert `${mediaType}:${tmdbId}` into a run-level emitted set (+ resolved name/year into `seenKeys`); return null on hit.
- **Effort:** S · **Route:** Sonnet

### [SEV-medium] LOGIC-2 · Three paths to "show fully watched" write three different event logs
- **Where:** `src/lib/actions.ts` — status dropdown (:353-384) logs `TITLE_COMPLETED` + no episode events; season/all bulk marks (:770-791, :830-848) log per-episode events + no completion; ticking the last episode (`recomputeProgress` :229-265) logs neither completion nor status event.
- **Impact:** derived values disagree by path — `getExportRows.watchCount` (`data.ts:554-562`) reports **0 watches** for tracker-completed shows (badge + AI-brief rewatch signal wrong); heatmap counts differ; a later `logWatch` records a `REWATCH` for a title with no completion in its log.
- **Fix:** `recomputeProgress` appends `TITLE_COMPLETED` (source BULK) on the transition into WATCHED (it already detects it to stamp `watchedAt`); decide deliberately whether status-driven completion also logs episode events — converge all three paths.
- **Effort:** M · **Route:** Codex

### [SEV-medium] LOGIC-3 · `recomputeProgress` demotes deliberate WATCHING to WATCHLIST at zero progress
- **Where:** `src/lib/actions.ts:244-249` (protects ON_HOLD/DROPPED but not WATCHING) — contradicts the import-side "keep the imported intent" rule (`src/lib/import/run-import.ts:434-445`, tested).
- **Impact:** import a show as WATCHING with 0 ticks, tap one episode by mistake and untick it → show silently moves to Watchlist (and switches blocks in the AI taste brief).
- **Fix:** at `watched === 0`, preserve current status unless it is WATCHED (mirror `deriveStatus`).
- **Effort:** S · **Route:** Codex (bundle with LOGIC-2)

### [SEV-medium] LOGIC-4 · Re-importing Celluloid's own xlsx export mis-matches and silently drops data
- **Where:** export writes "TMDB" (a **rating** column) and "Release Date", split Movies/"TV Shows" sheets (`src/lib/export/xlsx.ts:13, 27, 89-90`); importer reads bare `tmdb` alias as a TMDB **id** (`parse-upload.ts:460`) → integer ratings resolve to unrelated real titles staged at score 1 (`import-staging.ts:299-329`); only `worksheets[0]` parsed (:391) so the TV sheet is silently ignored; `releasedate` missing from year-header list (:435) → year-less weakest matching.
- **Impact:** the predictable "friend seeds their library from the owner's export" flow produces confidently wrong titles (with statuses/ratings/dates attached), loses every TV row, and matches the rest without year disambiguation.
- **Fix:** (a) drop/tighten the bare `tmdb` alias (require id-shaped value + "id" in header); (b) parse all sheets or surface "N sheets ignored"; (c) add `releasedate`/`datereleased` aliases; ideally add real "TMDB ID"/"IMDb ID" columns to the export so the round trip is exact.
- **Effort:** M · **Route:** Codex

### SEV-low (LOGIC-5 … LOGIC-13) — correctness polish
| # | Item | Where | Fix | Route |
| --- | --- | --- | --- | --- |
| LOGIC-5 | Backdating a completion can desync `watchedAt` from the event log (and clears can resurrect) | `actions.ts:332-338, 386-401` vs `:520-537` | call `syncWatchedAtFromEvents` after re-dating | Codex (watch cluster) |
| LOGIC-6 | `logWatch` on partially-watched TV records a `TITLE_COMPLETED` that isn't one → double-counted completions | `actions.ts:447-459` vs `:475-482` | relabel/guard partial-TV logs | Codex (watch cluster) |
| LOGIC-7 | Backdated completion stamps episodes `watchedAt = now` instead of the given date | `actions.ts:353-357` | `newWatchedAt ?? now` | Codex (watch cluster) |
| LOGIC-8 | Runtime-less watched movies add 0 min with no "Est." hedge | `data.ts:974-977, 1013-1023` | count them into the estimated tally | Sonnet |
| LOGIC-9 | Heatmap "today" is client-UTC while day keys are owner-local (evening east of UTC → today greyed as future) | `charts.tsx:198-217` | pass server-computed owner-zone `todayKey` | Sonnet |
| LOGIC-10 | "On my services" can't distinguish "not available" from "never checked" — non-watchlist titles unconditionally hidden | `library.tsx:283-288`, `metadata-sync.ts:351-357` | product call: scope the toggle, extend sync, or surface a third state | owner decision |
| LOGIC-11 | Regioned language codes (`pt-BR`) validate but can never match TMDB's bare `pt` → near-empty runs (latent) | `api/recommend/route.ts:35-41`, `recommend.ts:369-389` | normalize to primary subtag or tighten regex | Sonnet |
| LOGIC-12 | Session "already shown" exclusion is name-only across media types (movie "Fargo" blocks TV "Fargo") | `recommend.ts:706, 807` | key on `mediaType:norm(title)` | Sonnet |
| LOGIC-13 | Top-rated ties reorder between loads; released-only gate uses server-UTC today | `data.ts:887-902, 1088`; `recommend.ts:442-445` | name tie-break; date tolerance | Sonnet |

(The logic auditor independently re-found API-3 — provider-only sync failures pinning the queue — confirming that finding; recorded once under API-3.)

## Findings — Reliability / Ops / Deployment

### [SEV-high] OPS-1 · Split-brain env-file loading: prod scripts read `.env.local`, Prisma CLI reads `.env`
- **Where:** `package.json:14-15` (`db:deploy:prod`, `db:dump` → `--env-file-if-exists=.env.local`), `prisma.config.ts:1` + `scripts/ensure-indexes.mjs:21` + `scripts/backfill-discovered-at.mjs:11` + `scripts/import-excel.ts:1` (`dotenv/config` → `.env` only), `scripts/deploy-prod-migrations.mjs:21` (no dotenv at all), `README.md:417`, `env.example:18-30`.
- **What:** two disjoint conventions. Following env.example's own instructions (`.env`) breaks `db:deploy:prod`/`db:dump`; using Next's standard `.env.local` (what this repo now has, post secret-fix) breaks `db:migrate`/`db:deploy`/`db:push`/`db:indexes`/`import`. All failures are fail-closed (nothing hits the wrong DB) — but the documented runbook does not execute as written. **Note:** directly relevant right now — secrets live in `.env.local`, so the Prisma CLI script family currently can't see `DATABASE_URL`.
- **Fix:** one convention everywhere — have every script load `.env.local` then `.env` (Next-style precedence) via shared flags/loader; document once in README.
- **Effort:** S · **Route:** Codex (bundle with OPS-2)

### [SEV-medium] OPS-2 · README's first onboarding command references a file that doesn't exist
- **Where:** `README.md:398` (`cp .env.example .env` — actual file is `env.example`), also :417, :538; stale `!.env.example` negation in `.gitignore:36`.
- **Impact:** the literal first shell command a friend copies fails. Front door of onboarding.
- **Fix:** rename `env.example` → `.env.example` (the .gitignore negation already anticipates it) and align README. **Effort:** S · **Route:** Codex (with OPS-1)

### [SEV-medium] OPS-3 · `db:push`-managed DBs silently lack the nine CHECK constraints prod gets from migrations
- **Where:** `prisma/migrations/20260717221157_workflow_foundation/migration.sql:175-184` (9 hand-written CHECKs — rating domain, counter consistency); `scripts/ensure-indexes.mjs:5-11, 37-40` restores only the Tag index (its "exactly one such object" header is now wrong); `db:push` chains only `db:indexes`.
- **Impact:** dev accepts writes prod rejects — a bug producing e.g. `watchedEpisodes > totalEpisodes` sails through dev and explodes only in production as a P2010. (Whether `db push` also drops existing CHECKs: UNVERIFIED — confirm on a scratch Neon branch.)
- **Fix:** extend `ensure-indexes.mjs` to re-apply the CHECKs idempotently (pg_constraint existence check), or make `db:migrate` the only dev flow. **Effort:** M · **Route:** Codex

### [SEV-medium] OPS-4 · Degraded cron runs are invisible; per-title failure state is written but read nowhere
- **Where:** `src/app/api/cron/sync/route.ts:92-102` (summary only in the response body, no `console.log` on success; degraded → 200), `metadata-sync.ts:647-659` (FAILED + `metadataLastError` persisted; grep confirms nothing ever reads them).
- **Impact:** titles with a dead TMDB id quietly stop refreshing forever; the owner can't notice without querying the DB.
- **Fix:** (1) one JSON `console.log` line per run; (2) surface FAILED titles + `metadataLastError` in Settings or a library filter chip. **Effort:** S + M · **Route:** Codex

### [SEV-medium] OPS-5 · No automated backup; Neon retention assumed, not confirmed
- **Where:** backup is owner-initiated only (`api/backup/route.ts:9` session-gated GET; `README.md:232-256` manual runbook); one of two Hobby cron slots free (`vercel.json:3-8`).
- **Impact:** a destructive mistake noticed after a weekend can be unrecoverable if the PITR window rolled past and no recent manual backup exists.
- **Fix:** weekly backup via the free second cron slot (CRON_SECRET-gated envelope export → store/log), or at minimum record the confirmed Neon retention number in README. **Effort:** M · **Route:** owner decision → Codex

### SEV-low (OPS-6 … OPS-9)
| # | Item | Where | Fix | Route |
| --- | --- | --- | --- | --- |
| OPS-6 | Cron/DB path bypasses `env.ts` fail-fast validation → misconfig surfaces as raw `ECONNREFUSED` at localhost | `src/lib/prisma.ts:15`, `metadata-sync.ts:97` | import `env` in prisma.ts / metadata-sync | Sonnet |
| OPS-7 | No pool tuning; no runtime assertion that the URL is the `-pooler` endpoint | `src/lib/prisma.ts:14-17` | one-time prod `console.warn` when host lacks `-pooler`; explicit `max` | Sonnet |
| OPS-8 | `backfill-discovered-at.mjs` runs an unconditional UPDATE with none of its siblings' guardrails | `scripts/backfill-discovered-at.mjs:8-31` | copy the describeTarget + confirmation block from deploy-prod-migrations | Sonnet |
| OPS-9 | Vercel's actual Node pin UNVERIFIED (engines allows 22-24; CI tests 22/24) | `package.json:7-9`, `.github/workflows/ci.yml:16-17` | owner: check Project Settings → Node.js Version | owner |

## Recommend-tab deep-dive (owner-reported: "AI works slowly or not at all sometimes")

### Ranked: most likely causes of the symptom
1. **Slowest-possible default config vs a fixed 50s budget.** Default is Opus 5 + adaptive thinking + effort medium (`src/lib/models.ts:12`, `recommend.ts:738-744`), and the server over-asks 2-4× (`recommend.ts:641-642` — a 20-title run asks for 50 structured suggestions) against a 50s deadline (`api/recommend/route.ts:136`). Cold-cache runs take 10-30s to first card; the worst hit the time limit with few or zero results. Prompt-cache hits make repeat runs fast → intermittent by nature — exactly "sometimes". **Confirm:** symptom vanishes on Haiku 4.5, or the "hit the server's time limit" message appears.
2. **TMDB enrichment on every card's critical path** — up to 15s of retries per suggestion (`tmdb.ts:72-123`), 5 lanes; a degraded TMDB turns a run into chained stalls until the deadline fires. **Confirm:** "TMDB couldn't be reached to verify…" warning on slow runs.
3. **No client stall watchdog** — a silently dead connection leaves `reader.read()` pending forever (`recommend-client.tsx:391-406`): permanent spinner, no error, no reset. Strongest match for "doesn't work at all". **Confirm:** stuck "Picking titles…" with a pending request in DevTools.
4. **Truncated terminal NDJSON line silently discarded** (`recommend-client.tsx:394-406` — leftover buffer never flushed): a 60s Vercel kill or socket drop makes a cut-short run look finished or blandly empty. Prod-only.
5. Anthropic-side 529/429 intermittency — surfaced correctly with actionable copy; a match only if red messages were seen.
6. 0.5-2s of serialized pre-stream DB reads + cold start (= PERF-5).
7. Self-inflicted 429 from the 10/min limiter — clearly surfaced; low likelihood.

### [SEV-medium] REC-1 · Dismissing a card during an active stream resurrects it
- **Where:** `recommend-client.tsx:270` (dismiss filters state) vs `:378-380` (`got` closure re-sets state) and `:412-414` (final rank rebuilds from `got`).
- **Impact:** dismissed card pops back seconds later — looks like dismiss "didn't work" (the suppression WAS durably recorded).
- **Fix:** track dismissed identities in a ref and filter `got` on every set/rank. **Effort:** S

### [SEV-medium] REC-2 · No abort on unmount — navigating away keeps burning Anthropic tokens
- **Where:** `recommend-client.tsx:200, 258-260, 326-328` — no `useEffect` cleanup aborts `abortRef`; server abort wiring is correct but never triggered.
- **Impact:** up to ~50s of Opus tokens + dozens of TMDB calls per abandoned run.
- **Fix:** `useEffect(() => () => abortRef.current?.abort(), [])`. **Effort:** S

### [SEV-medium] REC-3 · No client-side stall watchdog on the stream reader
- **Where:** `recommend-client.tsx:391-406`; `finally` reset (:409-419) never runs if `read()` never settles.
- **Impact:** the permanent-spinner "doesn't work at all" presentation.
- **Fix:** per-read silence timeout (~20s) → abort with a "connection stalled" error. **Effort:** S

### [SEV-medium] REC-4 · Truncated final NDJSON line silently discarded — terminal errors vanish
- **Where:** `recommend-client.tsx:394-406` (no flush of remaining `buf` on `done`).
- **Impact:** killed runs render as successes or bland empty states; masks cause #1.
- **Fix:** parse leftover `buf` after the loop; if no `done`/`error` event arrived, surface "the run was cut short". **Effort:** S

### [SEV-medium] REC-5 · Default model/effort is the slowest option; UI never sets a time expectation
- **Where:** `models.ts:12`, `recommend.ts:641-642, 738-744`; phase labels and "Model & cost" copy never mention time (`recommend-client.tsx:55-59, 781-783`).
- **Fix (owner decision):** default to Sonnet 5 ("Near-Opus quality, faster" per its own copy), and/or add "can take up to a minute on Opus" copy, and/or `effort: "low"` for this interactive path. **Effort:** S-M

### SEV-low (REC-6 … REC-10)
| # | Item | Where | Fix |
| --- | --- | --- | --- |
| REC-6 | Suppressions enforced to 2000 but panel lists only newest 500 — the rest are invisible and unrestorable | `suppression-actions.ts:56,137` vs `recommend.ts:225,232` | truncation notice + search/pagination (M) |
| REC-7 | Genre filter silently degrades to advisory when the name doesn't exist for the media type (e.g. Movies + "Action & Adventure") | `tmdb.ts:439-458`, `recommend.ts:379-386` | warn once when the id set is empty |
| REC-8 | Double error events on zero-result deadline runs; dismiss-all shows untrue "No suggestions came back" | `recommend.ts:513-519`, `recommend-client.tsx:385-387, 925-929` | suppress generic error on deadline abort; distinguish emptied-by-dismissal |
| REC-9 | Key-source opacity — user's key vs owner's server fallback invisible ("whose quota?") | `page.tsx:40`, `anthropic.ts:38` | one line in Model & cost: "Using your key / this server's shared key" |
| REC-10 | React key collision for unresolved same-title suggestions under AnimatePresence | `recommend-client.tsx:892` | include year in the fallback key |

**Selection features verified correct** (no findings needed): TitlePicker seed threading + scoping, Tune-results filters reaching API/prompt/enforcement with validated cookie persistence and clean stale-value degradation, model selector optimistic-persist with revert, suppress/un-suppress serialization, dismiss-undo positional restore.

## Findings — Performance

### [SEV-medium] PERF-1 · Library search mirrors every keystroke into `history.replaceState` + a cookie write
- **Where:** `src/components/library.tsx:173-213` (effect deps include `query`); cookie value doesn't even contain the query (`remembered-state-client.ts:26-38`) so the write is identical churn.
- **Impact:** Safari hard-throttles `replaceState` to 100 calls/30s and **throws a `SecurityError`** past that — a fast typist on iOS can break the library page; Chrome throttles silently.
- **Fix:** debounce the URL/cookie mirror (~300ms trailing, flush on unmount); skip the cookie write when unchanged.
- **Effort:** S · **Route:** Sonnet

### [SEV-medium] PERF-2 · Search filtering fully synchronous — no `useDeferredValue`
- **Where:** `library.tsx:143, 270-325, 856-883` — every keystroke re-runs filter O(n) + sort O(n log n) + full-grid reconciliation at input priority.
- **Impact:** typing jank on mobile at 1-2k titles.
- **Fix:** feed a `useDeferredValue(query)` into the `filtered` memo.
- **Effort:** S · **Route:** Sonnet

### [SEV-medium] PERF-3 · Nightly sync re-fetches every season of every candidate show, even when nothing changed
- **Where:** `metadata-sync.ts:668-687` (1 detail + N season requests per TV candidate, all seasons, every night, `no-store`); TMDB's detail response already carries per-season `episode_count`/`air_date`, and the DB stores `Season.episodeCount`.
- **Impact:** big-show nights exhaust the 45s budget on unchanged data, pushing the rest of the queue back days → staler air dates, later "New episodes" badges.
- **Fix:** diff `detail.seasons[]` against stored counts/dates and fetch only changed seasons (+ the newest one or two); upsert layer already no-ops unchanged rows.
- **Effort:** M · **Route:** Codex (bundle with T8 sync work)

### SEV-low (PERF-4 … PERF-9)
| # | Item | Where | Fix | Route |
| --- | --- | --- | --- | --- |
| PERF-4 | Title page payload O(episodes) — 2k-episode soap ≈ ~250KB props + O(episodes) client work per render (UNVERIFIED bytes) | `data.ts:597-628`, `title/[id]/page.tsx:229-243` | per-season summaries + lazy episode lists; only if 500+ ep shows are tracked | defer |
| PERF-5 | Recommend run: 4-6 sequential DB awaits before the Claude stream starts (~50-250ms avoidable) | `recommend.ts:574-702` | `Promise.all` the independent reads | Codex (recommend cluster — see deep-dive) |
| PERF-6 | Stats page: timeZone fetched twice, two avoidable waterfall stages | `data.ts:843-848, 883-946` | shared `cache()`d `getUserPrefs` + one `Promise.all` | Sonnet |
| PERF-7 | User pref row read 2× per request on settings/title/upcoming pages | `settings/page.tsx:56-64`, `title/[id]/page.tsx:72` + `title-extras.tsx:49-55`, `upcoming/data.ts:78-84` | same `cache()`d `getUserPrefs` | Sonnet (with PERF-6) |
| PERF-8 | Full framer runtime (~35-45KB gz) in the app shell; usage fits `LazyMotion domMax` (UNVERIFIED savings) | `components/motion.tsx:3-13` | `m` components + `LazyMotion strict` inside the existing provider | Codex (contained but subtle) |
| PERF-9 | /export serializes the whole library incl. notes into client props on open | `export/page.tsx:22-27` | fetch-on-demand if it ever matters | defer |

## Toolchain verification (tsc / lint / tests)

Run 2026-08-29 after a fresh `npm ci` (642 packages; `prisma generate` ok):

- **tsc --noEmit:** ✅ pass, no errors
- **lint:** ✅ pass, no errors or warnings
- **tests:** ✅ **331/331 pass** (86 suites, ~9s), 0 fail/skip

### [SEV-low] TOOL-1 · Local Node is v26.8.0-alpha — outside the project's own engines contract
- **What:** `package.json` engines requires `>=22 <25`; the installed Node (26.8.0-alpha) violates the upper bound and npm 11.19 doesn't officially support it (`EBADENGINE` + npm warnings). Everything passed anyway, but local runs are on an unsupported combination; Vercel builds pin their own Node so prod is unaffected.
- **Fix (owner):** switch local Node to a 22.x or 24.x LTS (nvm-windows/volta), or consciously widen the engines range.
- **Effort:** S · **Route:** owner
- Routine noise (non-blocking): deprecated transitive deps, npm audit 10 high/4 moderate in transitives (see SEC-4 for the actionable part), npm 11 install-scripts gate notice for 5 packages.

---

## What is already solid (verified, don't re-litigate)

- **Multi-user isolation is real and complete** — every domain model carries `userId` with cascade delete; every query path filters on it (all `src/lib/data.ts` readers, all five server-action modules, raw SQL, import staging, per-user cron sync). A friend gets an empty, private library. No cross-user path found.
- **Every API route authenticated or secret-gated**; `(app)` group gated by `requireUser()` in layout + per page; cron requires ≥32-char `CRON_SECRET`, constant-time compare, IP-keyed guess limiter.
- **Share links:** 72-bit random slugs, revoke/restore/expiry enforced at resolve, notes off by default, output-boundary gate unit-tested, noindex + robots disallow, rate-limited.
- **Upload hardening:** size caps with Content-Length pre-checks, genuine ZIP-bomb preflight, HMAC-signed TTL'd state-digest-bound restore confirmation tokens.
- **No SSRF surface**; open-redirect-sanitized `?next=`; nonce-based strict-dynamic CSP; HSTS-preload; secrets never echoed to client (only `hasApiKey`), per-user keys AES-256-GCM.
- **TMDB client matches the real API contract** (verified against local tmdb-docs mirror); layered timeouts/budgets/Retry-After; sync distinguishes budget-exhausted from failed.
- **Lock discipline uniform** (`FOR UPDATE` on Title before multi-step writes, P2002 re-read recovery everywhere needed); import pipeline resumable/cancel-safe; backup uses `REPEATABLE READ` snapshot + previewed-state-bound restore.
- **Anthropic usage current** (structured output, refusal handling, stream deadlines under function limits, abort-on-enough, correct cache breakpoints).
- **Frontend:** systematic empty states, per-route skeletons, disciplined optimistic rollback, single confirm-dialog pattern for all destructive actions, strong keyboard/focus/reduced-motion/contrast work, 44px touch targets, lazy-loaded heavy deps, deliberate single dark theme.

---

## Delegation plan (draft — finalize after pending sections land)

**Owner decisions (resolved 2026-08-29, recorded in `.agent-collaboration/DECISIONS.md`):**
1. SEC-2 → **invite token** (D-005) — T3.
2. SEC-3 → **own key optional; shared key default with a global env-configured daily budget cap; no admin UI** (D-006) — T4.
3. REC-5 → **default to Sonnet 5 + latency copy** (D-007) — T9.
4. OPS-5 → **backups stay manual** (D-008).
5. env.example incident → **no rotation** (D-009).

**Still open (owner):**
- API-8 / T4 migrations — approve before any `migrate deploy`.
- SEC-4 dependency bump (next 16.3.3 etc.) — approve before Sonnet runs it.
- API-6 — check `DIRECT_URL` is set in Vercel project settings.
- OPS-9 — check Vercel's Node.js version pin (22 or 24).
- LOGIC-10 — "On my services" scope (watchlist-only by design, or extend?).

**Scope adjustments during dispatch** (to keep one owner per file): UI-2 folded into T1; UI-1 into T2; UI-4 + LOGIC-1 into T9/T10; Sonnet batches resequenced — library.tsx work queues behind T2, settings/stats dedup work behind T1. Live scopes are on `TASKS.md`.

**Codex (GPT 5.6 Sol) — substantial work, one task each on the board:**
- T1: Devices/sessions section in Settings (SEC-1) — the headline feature.
- T2: Server-action error contract migration (API-1) — mechanical but wide; prod-visible copy through humanizer.
- T3: Signup gating per owner decision (SEC-2) + onboarding nudge to 2FA (SEC-6).
- T4: Anthropic cost control per owner decision (SEC-3).
- T5: Import/export round-trip cluster — commit deadline budget (API-2), own-export re-import collisions (LOGIC-4), backup size warning (API-4).
- T6: Watch-history consistency cluster — event-log convergence (LOGIC-2), WATCHING demotion (LOGIC-3), backdate/partial-TV/episode-stamp lows (LOGIC-5, LOGIC-6, LOGIC-7, API-5).
- T7: Env/onboarding unification — split-brain env loading (OPS-1) + `env.example` rename/README fix (OPS-2). Small but high-leverage; blocks friends' onboarding.
- T8: Dev/prod schema parity + sync efficiency/visibility — CHECK-constraint restoration (OPS-3), cron run summary log + FAILED-title surfacing (OPS-4), season-diff fetch reduction (PERF-3).
- T9: Recommend-tab reliability cluster — stream hardening (REC-2 unmount abort, REC-3 stall watchdog, REC-4 tail flush, REC-1 dismiss-resurrect), REC-8 error-copy fixes, PERF-5 (parallelize pre-stream reads), REC-5 default/latency-copy per owner decision. This cluster directly targets the owner's "slow or dead AI" symptom.
- T10: Recommend-tab polish riders — REC-6 suppressions pagination, REC-7 genre warn, REC-9 key-source line, REC-10 key fallback, PERF-8 LazyMotion swap.

**Sonnet — small mechanical fixes, batched:**
- B1: Dependency bumps + audit fix + test rerun (SEC-4).
- B2: UI mediums UI-1…UI-4 (toasts, saveBlob share, palette retry, chevrons) + LOGIC-1 (rec dedupe).
- B3: Low-severity polish batch — UI-5…UI-17 (copy items through humanizer), API-3, API-7, API-6 build warning, LOGIC-8, LOGIC-9, LOGIC-11, LOGIC-12, LOGIC-13.
- B4: Ops lows — env.ts fail-fast in prisma/metadata-sync (OPS-6), pooler warn + explicit pool max (OPS-7), backfill-script guardrails (OPS-8).
- B5: Library hot path + request dedup — keystroke debounce (PERF-1), deferred search value (PERF-2), shared `getUserPrefs` cache (PERF-6, PERF-7).

**Verification:** every task lands with tsc/lint/test evidence; Fable reviews each diff before DONE.
