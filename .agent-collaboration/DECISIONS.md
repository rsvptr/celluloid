# Shared decisions log

Durable decisions, append-only. Written by Fable 5; Codex proposes decisions through `CODEX_TO_CLAUDE.md`. If a decision changes, add a new entry that supersedes the previous one instead of rewriting history.

Format per entry: ID · UTC timestamp · decision · rationale · who decided · supersedes (if any).

---

**D-005** · 2026-08-29 20:09 UTC · Friend accounts are created via an invite token: signups stay closed unless a valid shared invite code (env-configured) is presented, checked server-side in a better-auth hook. · Avoids the open-signup exposure window (SEC-2) with no admin UI. · Owner · supersedes —

**D-006** · 2026-08-29 20:09 UTC · AI recommendation costs: users MAY bring their own Anthropic key; by default everyone uses the deployment's shared key, protected by a global (all-users combined) daily budget cap configured via env var — durable counter in Postgres, no admin account/page. Users with their own key bypass the cap. Over-cap runs get a friendly error suggesting adding a personal key in Settings. · Owner wants zero-admin operation with bounded spend (SEC-3). · Owner · supersedes —

**D-007** · 2026-08-29 20:09 UTC · Recommend default model switches from Opus 5 to Sonnet 5; Opus stays selectable. Latency expectation copy added near the run flow. · Opus+thinking default was the top-ranked cause of the owner's "AI slow" symptom (REC-5). · Owner · supersedes —

**D-008** · 2026-08-29 20:09 UTC · Backups remain manual-only; no scheduled backup cron. · Owner preference (OPS-5). · Owner · supersedes —

**D-009** · 2026-08-29 20:09 UTC · The env.example secrets incident (real values in the tracked template) was resolved by moving values to gitignored `.env.local` and restoring placeholders; NO credential rotation — values were temporary dev credentials, never committed. · Verified against full git history (AUDIT.md, resolved section). · Owner · supersedes —

**D-010** · 2026-08-29 21:42 UTC · The D-006 shared-key budget cap is denominated in RUNS PER DAY (`SHARED_AI_DAILY_RUN_LIMIT`): one atomic durable reservation per shared-key recommendation run; own-key runs never count. Worst-case spend stays bounded by runs × per-run token ceiling, backstopped by a spend limit set in the Anthropic console. · A dollar/token ledger cannot settle reliably because abort-on-enough streams may never deliver terminal usage (Codex proposal CDX-017, adopted by Fable). · Fable (refining owner decision D-006) · supersedes — (amends D-006)

**D-011** · 2026-08-30 · "On my services" (LOGIC-10): extend nightly provider-sync eligibility from watchlist-only to ALL non-deleted, non-DROPPED titles, strictly within the existing per-run candidate cap and time budget (zero added nightly TMDB volume — a larger pool rotates through the same allowance). The library filter surfaces a third state: titles whose availability has not been checked yet are counted and named in the filter's status copy instead of being silently hidden. · Owner: "improve it without risking the API"; owner rarely uses the feature, so slower rotation is acceptable. · Owner + Fable · supersedes —
