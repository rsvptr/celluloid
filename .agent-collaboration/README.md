# .agent-collaboration — Fable 5 ↔ GPT 5.6 Sol protocol

A file-based protocol for running two AI coding agents side by side in the same repository, each in its own terminal, coordinating only through append-only files.

## Team

| Agent | Runs in | Role |
| --- | --- | --- |
| **Fable 5** | Claude Code | Orchestrator, senior decision-maker, reviewer. Complete creative + architectural control. |
| **GPT 5.6 Sol** | Codex | Implementor and hard/creative-work tier. Implements tasks; may propose creative alternatives. |
| **Sonnet 5** | Claude Code subagent (spawned by Fable) | Cheap discovery, file/log summaries, tests, verification. Not on this mailbox. |

Fable reviews everything GPT 5.6 Sol produces. Sol's suggestions can be adopted, but the decision is always Fable's.

## Running it (two terminals, same repo)

1. **Terminal A** — `cd` into the repo, start Claude Code. Fable is the default agent (set in `.claude/settings.json`).
2. **Terminal B** — `cd` into the *same* repo, start Codex. Point it at `CODEX_INSTRUCTIONS.md` (or copy that file's contents into the repo's `AGENTS.md`) so GPT 5.6 Sol loads its role and this protocol at startup.
3. Both agents share the working tree and coordinate only through the files in this folder.

## Files

- `CLAUDE_TO_CODEX.md` — Fable → Codex outbox (Fable writes, Codex reads).
- `CODEX_TO_CLAUDE.md` — Codex → Fable outbox (Codex writes, Fable reads).
- `TASKS.md` — shared task board with a claim protocol.
- `DECISIONS.md` — durable decisions (Fable writes; Codex proposes via its outbox).
- `OWNERSHIP.md` — collision/ownership rules and the claim protocol.
- `CODEX_INSTRUCTIONS.md` — the role + protocol brief for the Codex side.

## Message format (both outboxes)

```
### <MSG-ID>  ·  <UTC timestamp>
- **Re:** <task or message ID, or "—">
- **Type:** task | question | completion | blocker | suggestion | review
- **Reply requested:** yes | no
- **Files:** <paths touched, or "—">

<body>
```

## Workflow

1. Fable decomposes the request, adds tasks to `TASKS.md` as `READY`, and posts an assignment in `CLAUDE_TO_CODEX.md`.
2. GPT 5.6 Sol claims a `READY` task (`CLAIMED` + its name), implements it, moves it to `REVIEW`, and posts a completion in `CODEX_TO_CLAUDE.md` with files changed, what was tested, and known risks.
3. Fable reviews, then marks the task `DONE` or replies with feedback. Blockers and questions go to the relevant outbox with **Reply requested: yes**.
4. Anything high-risk (auth, migrations, dependency or destructive changes) waits for explicit user approval before it is made.

## Using this in another codebase

Copy into the target repo root:

- `.claude/agents/fable-chief-agent.md` and `.claude/agents/sonnet-5-delegate.md`
- `.claude/settings.json` (sets Fable as the default agent)
- this entire `.agent-collaboration/` folder

Then reset `TASKS.md`, `CLAUDE_TO_CODEX.md`, `CODEX_TO_CLAUDE.md`, and `DECISIONS.md` to their empty templates. Nothing here hardcodes a project name, so it is portable as-is. (Note: `.claude/launch.json` is project-specific — replace or delete it per repo.)
