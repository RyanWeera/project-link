# project-link

A Claude Code mod: projects on one computer send work to each other through a file mailbox, and `/messages` / `/edit` change earlier messages so Claude rereads them. Public at github.com/RyanWeera/project-link.

@DIRECTORY_MAP.md

## Commands
- Validate: `claude plugin validate .`
- Test all: `claude plugin test .` (files: `hooks/mail.test.ts`, `hooks/session.test.ts`, `hooks/edit.test.tsx`)
- Type check: no tsc here; use `npx -y -p typescript@5.9.3 tsc -p <tsconfig>` with the config from the header of the engine's `claude-code.d.ts`, its `include` set to this folder's `hooks` and `types`. It passes with no errors (`noUncheckedIndexedAccess` is on).

## Conventions
- This folder (git) is the source of truth. After an edit, copy `hooks/`, `types/` and `.claude-plugin/plugin.json` to `~/.claude/local-marketplace/plugins/project-link/`, the installed copy.
- Test data uses made-up names (`Plugin Lab`, `Video Site`, `C:/Users/me`): no real paths or project names.

## Gotchas
- `$` cannot cross a file import: `edit.tsx` registers its own hooks, and its `session.start` and `turn.complete` hooks carry match-all matchers because `register.tsx` has matcherless ones on those events.
- `$.session.compact` is refused in the desktop app's (SDK) sessions. The cold-chat compaction goes through `$.command.run({ command: 'compact', args })`, which runs once idle. `edit.tsx` starts no compaction: the person asked to run `/compact` themselves, so waiting edits go in at the next compaction of any kind, and a `precompute` is vetoed while edits wait (its summary would miss them). Engine 2.1.321 reuses a summary made ahead of time, at `/compact` and at auto compaction, only when no hook rewrote the messages it covers, so an edit made after a precompute is not lost to it.
- A transcript row (`UserMessage`, `AssistantMessage`) has a `requestId`, but `SessionMessage` has no id to match it to: `edit.tsx` finds its message by role and text, and a waiting change by its index, role and old text. A Box drawn shown must not also carry `hover: { display: 'flex' }`, or the engine refuses the tree.
- `$.state` outlives `/clear`: the process goes on under a new session id and no `session.start` fires. So `edit.tsx` drops the waiting changes at `session.end` with reason `clear` or `resume`.
- The test kit cannot raise `model.fork`, so the keep-warm check in `register.tsx` has no test.
- Auto mode is off when `auto.json` is missing, and the trust list starts empty. A test that needs auto mode writes `{"on":true,"trust":"*"}` and a registry entry with a `path`: an untrusted sender, or one with no registered path, waits for a button.
- `$.prompt.submit` can refuse by resolving `{ drop }`. `act()` then puts the message back to "new" and back in the bar.
- The first poll runs on `$.clock.after(0)`, not inside `session.start`: a `/compact` queued from a hook that session start waits on is refused. So `start()` in `session.test.ts` advances the mock clock by 0 after `session.start`.
