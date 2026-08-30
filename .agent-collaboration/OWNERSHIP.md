# File ownership and collision rules

These rules apply whenever Claude Code (Fable 5) and Codex (GPT 5.6 Sol) work in the same repository concurrently, each in its own terminal.

## Roles

- **Claude Code — Fable 5**: orchestrator, senior decision-maker, and reviewer. Holds complete creative and architectural control. Decomposes work, dispatches tasks, reviews all output, and gives final approval.
- **Codex — GPT 5.6 Sol**: implementor and hard/creative-work tier. Implements claimed tasks and may propose creative alternatives; Fable decides whether to adopt them.
- **Sonnet 5**: a Claude subagent spawned by Fable for cheap discovery/verification. It does not participate in this mailbox directly.

## Communication ownership (single writer per file)

| Path | Writer | Other agent |
| --- | --- | --- |
| `.agent-collaboration/CLAUDE_TO_CODEX.md` | Claude Code (Fable) | Codex reads only |
| `.agent-collaboration/CODEX_TO_CLAUDE.md` | Codex (GPT 5.6 Sol) | Claude Code reads only |
| `.agent-collaboration/DECISIONS.md` | Claude Code (Fable) | Codex proposes via its outbox |
| `.agent-collaboration/OWNERSHIP.md` | Set by the user | Changes require user approval |

These files are append-only. Never rewrite earlier entries.

## Task board (`TASKS.md`) claim protocol

`TASKS.md` is shared, but each row has exactly one owner at a time:

1. Fable adds tasks and marks them `READY` (or `PROPOSED` when not yet approved).
2. An agent claims a `READY` task by setting its status to `CLAIMED` and writing its own name in the Owner column. Only edit rows you own.
3. The owner moves the task to `REVIEW` when implementation is complete.
4. Fable reviews and marks it `DONE`, or sends it back with a message.
5. Use `BLOCKED` when a task cannot proceed without a decision or external input.

## Application-file rules

1. A task must be `READY` before an agent claims it.
2. The claiming agent records an explicit path-level scope before editing.
3. Only one agent may own a path at a time.
4. An agent must inspect the current file immediately before editing, because the working tree may contain user or collaborator changes.
5. Do not overwrite, revert, stage, or commit another agent's work.
6. Cross-scope changes require a handoff message and acknowledgement.
7. Database migrations, dependency changes, destructive operations, and changes to authentication require explicit user approval.
8. Every handoff states what changed, what was tested, known risks, and the exact files involved.
