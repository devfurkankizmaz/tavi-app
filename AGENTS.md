# Notes for AI coding agents

Conventions that are easy to violate by accident. `CONTRIBUTING.md` covers
setup and workflow; this file covers the traps.

## Commands

- `npm run dev` — api + web
- `npm run check` — typecheck both workspaces. Run before every commit.
- `npm run regression` — end-to-end tests; needs `npm run dev` running
- `npm run db:migrate` / `db:seed` / `db:generate`

## Rules

**Schema changes always go through a Prisma migration.** Never edit the
database by hand and never edit an applied migration.

**Read generated migration SQL before applying it.** The full-text search
columns are `Unsupported("tsvector")` with GENERATED expressions and GIN
indexes created in raw SQL — none of which Prisma can model. It reads them as
drift, so anything it generates tends to open with `DROP INDEX
"Task_search_idx"` and `ALTER COLUMN "search" DROP DEFAULT`. Applying that
dismantles search without any error. Delete those statements; keep the rest.

**Every user-facing string lives in the dictionary.** `apps/web/src/i18n.tsx`
for the interface, `apps/api/src/i18n.ts` for server messages. The key type is
compile-time checked, so a typo fails the build. `t()` returns the key itself
for a missing entry rather than throwing — one bad key must never white-screen
the app.

**Access checks read `.role`, not the object.** `taskRole` and `documentRole`
return an object even when the caller has no access. Checking the object alone
is how a permission bug gets in; it has happened here twice. Never call
`atLeast(role as never, …)` — that cast is what hid both of them.

**Soft delete is real.** `Task`, `Project` and `Document` carry `deletedAt`.
Every query that lists or resolves them must filter it out.

**`"use client"` components never import server modules.** Node built-ins break
the web build.

## Personal screens

Three screens answer three different questions and must not be merged:

- **Overview** — what is happening in the workspace: projects, cycles, team
  activity. Not a task list. Adding "assigned to me" here makes it a copy of My
  work, which it once was.
- **Inbox** — what changed while you were away. Events, grouped by task.
- **My work** — what is on your plate. State, grouped by due date.

Inbox shows events, My work shows state. A task assigned three weeks ago that
nobody touched is in My work and not in Inbox.

## Assistant layer

- All LLM code is under `apps/api/src/agent/`: `config.ts` (provider selection
  and budgets), `provider.ts` (shared interface), `providers/*`, `tools.ts`,
  `runtime.ts`. Routes are in `routes/agent.ts`.
- **No key, no feature.** When `agentConfig.enabled` is false, `/agent/*`
  returns 503 and the interface draws nothing. Gate every new LLM surface on
  `useApp().agent.enabled`.
- **Nothing provider-specific leaks into `runtime.ts` or `assist.ts`.** Both
  only call `provider.chat()`. Adding a provider means one file under
  `providers/` plus a line in `config.ts`.
- Gemini 3 requires the `thoughtSignature` back beside every `functionCall`
  handed to it, or it answers 400. It travels opaquely in
  `ChatToolCall.signature` — do not interpret it, return it unchanged.
- Tools run with the user's own permissions. **There are no delete tools and
  there will not be.**
- `runtime.ts` is the chat: a tool loop that may write. `assist.ts` is the
  inline suggestions: one call, forced tool, **never writes**. Needing to write
  from `assist.ts` means the design is wrong — return a suggestion instead.
- New tool: call `budget(ctx)` if it writes, return through `brief(ctx, …)` so
  the card record is created, and go through `recordChange` so activity and
  notifications stay consistent.

## Search

- Full-text uses Postgres `tsvector`: GENERATED columns plus GIN indexes on
  `Task`, `Document` and `Comment`. The index follows content automatically.
- The dictionary is `simple` because content is mixed-language. No stemming;
  a `:*` prefix on the final term stands in for it.
- User input goes through `toTsQuery`, which reduces it to letters and digits
  so tsquery operators cannot be injected. Never build a query without it.
- Highlight markers are control characters, not HTML. The client splits on them
  and builds `<mark>`; user text is never rendered as markup.
- Every query is bounded by `accessibleProjectIds`.

## Email and deep links

- Notification mail goes through `mail-template.ts` as HTML plus plain text.
  Never send HTML alone — it gets treated as spam.
- Links point at `/go?to=…`, not directly at `/projects/…`. Signed out, the
  login screen keeps the destination and returns to it afterwards; through
  Google the destination rides in `state`.
- Both ends validate with `safeNext`: relative paths only. `//other.site` and
  absolute URLs are rejected. Skipping this creates an open redirect.

## Regression

- `npm run regression` hits a live API as four users: owner, editor, viewer,
  outsider.
- For any new feature write two checks: one that it works, and one that it
  **refuses the people it should refuse**. The permission bugs are always in the
  second direction.
- `apps/api/tsconfig.json` includes `scripts`, so the test runner is typechecked
  too.
