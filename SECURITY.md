# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting
on this repository, or open a private report at https://github.com/devfurkankizmaz/tavi-app/security/advisories/new.

Include what you found, how to reproduce it, and what an attacker could do with
it. You will get an acknowledgement within a few days.

## What Tavi already does

- Sessions are httpOnly JWT cookies; API tokens are stored as SHA-256 hashes and
  are shown in plaintext exactly once, at creation.
- Every query is scoped to the projects the requester can reach. There is no
  endpoint that returns rows from a project you were not given.
- File downloads check the parent task or document before streaming a byte.
- Redirect targets after sign-in accept relative paths only, so a link in an
  email cannot carry someone to another site.
- Full-text search reduces user input to letters and digits before it reaches
  `to_tsquery`, so query operators cannot be injected.
- The assistant runs with the requesting user's own permissions, has no delete
  tools, and is bounded per request by step, write, record and time budgets.

## What it deliberately does not do

- No rate limiting on general API routes; only the assistant is limited. Put it
  behind a reverse proxy if you expose it to the internet.
- No virus scanning on uploads. Files are stored under a server-generated name
  and served with `Content-Disposition: attachment` and `nosniff`, but nothing
  inspects their contents.
- No audit log export or retention policy beyond the 30-day trash window.
