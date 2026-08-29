# Contributing

Thanks for taking a look. Tavi is small on purpose, and the bar for a change is
simple: it should make the product better for a team that has to live in it
every day.

Taking part means agreeing to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting set up

```bash
npm install
cp .env.example .env               # DATABASE_URL and JWT_SECRET are the only required values
docker compose up -d db            # or point DATABASE_URL at your own Postgres
npm run db:migrate
npm run db:seed                    # sample data, so the app is not empty
npm run dev                        # API on :3457, web on :5173
```

Sign in with `ada@tavi.local` / `tavi-demo-1234`, or set `DEV_LOGIN=1` and use
the one-click developer login.

## Before you open a pull request

```bash
npm run check        # typecheck, both workspaces
npm run regression   # end-to-end tests, needs `npm run dev` running
```

CI runs the same two commands plus a production image build. A change that
breaks either will not merge.

## Screenshots

The images in the README are generated, not hand-taken:

```bash
npm run db:seed -- --reset
npm run dev
npm run screenshots        # in another terminal
```

It drives an already-installed Chrome through playwright-core, so nothing
large is downloaded. If a screen changes shape, regenerate rather than
letting the README drift.

The login shot is taken from a signed-out browser context before anything else,
and shows whatever the server is configured to offer. Set `GOOGLE_CLIENT_ID`
and `DEV_LOGIN=0` first, or it will capture the local developer shortcut
instead of the screen a real instance presents.

## Conventions worth knowing

**Every user-facing string lives in the dictionary.** `apps/web/src/i18n.tsx`
for the interface, `apps/api/src/i18n.ts` for server messages and email. No
component embeds a string. The key type is checked at compile time, so a typo
fails the build rather than the page.

**API routes follow one shape.** `handler` / `authUser` / `authMutation` /
`parseBody`, and every error responds as `{ error, code }`. Mutations are
admin-only by default; do not weaken tenant scoping to make something easier.

**Soft delete is real.** `Task`, `Project` and `Document` carry `deletedAt`.
Any query that lists or resolves them must filter it out, or deleted work
reappears somewhere it should not.

**Access checks read the role, not the object.** `taskRole` and `documentRole`
return an object even when the caller has no access; the truth is in `.role`.
Checking the object alone is how a permission bug gets in — it has happened
here before.

**`"use client"` components never import from the server.** Node built-ins
break the web build.

## Writing tests

`apps/api/scripts/regression.ts` runs against a live API as four users: owner,
editor, viewer and a complete outsider. When you add a feature, add two checks:
one that it works, and one that it refuses the people it should refuse. The
second is where the interesting bugs live.

## Commit messages

Conventional-commit style, present tense, English:

```
feat(inbox): group notifications by task
fix(attachments): a missing file no longer takes the server down
```

Say what changed and why it matters. If a commit fixes something subtle,
the message is the right place to explain what was actually wrong.
