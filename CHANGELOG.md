# Changelog

Notable changes to Tavi. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-08-29

First public release.

### Added

- Projects with short keys, so tasks read as `TAV-12` rather than `#4471`
- Tasks with kind, status, priority, estimate, dates, labels, assignees,
  subtasks, relations, comments, attachments and reminders
- Cycles that belong to a team and can pull work from several projects
- Six views over the same work: list, kanban, table, calendar, gantt and docs,
  plus one calendar across every project
- Blocking relations surfaced in every list and board, with a prompt before
  completing blocked work and a notification when the last blocker clears
- Overview, Inbox and My work as three separate answers to three questions
- Filters and the chosen view held in the URL, and saved views that can be kept
  private or shared with the project
- Postgres full-text search across tasks, documents and comments, ranked and
  highlighted
- Per-type notification preferences with independent in-app and email switches,
  and a daily digest
- Trash with a 30-day recovery window and an undo toast
- An optional assistant behind an Anthropic or Gemini key, running with the
  signed-in user's own permissions, with no delete tools and per-request budgets
- Command palette, keyboard shortcuts, a mobile layout, Slack notifications,
  email with deep links, an ICS calendar feed, JSON export and import, and API
  tokens
- Docker Compose deployment, and a regression suite that exercises every
  feature as owner, editor, viewer and outsider

[Unreleased]: https://github.com/devfurkankizmaz/tavi-app/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/devfurkankizmaz/tavi-app/releases/tag/v0.1.0
