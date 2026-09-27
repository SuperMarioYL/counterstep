# Changelog

## 0.1.0 - 2026-09-26

### Added

- m1 — `counterstep init` wires the Claude Code `PreToolUse` hook into
  `.claude/settings.json` (idempotent merge) and creates the `.counterstep/`
  state directory. File delete, overwrite and move calls are blocked until a
  shadow-rehearsed `fs_restore` inverse is armed.
- m2 — `git push --force*` interception: the remote ref is fingerprinted from
  the remote itself and the `force-with-lease` inverse is rehearsed against a
  bare shadow clone, so the real remote is only ever read during arming.
- m3 — `counterstep ledger` with per-artifact status, one-key
  `counterstep fire --last` with post-fire fingerprint verification, stale
  detection on drift, and the recorded demo (`docs/demo.gif`, script at
  `docs/demo.tape`).
- `docs/invertibility.md` — the standing classification of the destructive
  call surface: 15 invertible ops, 12 blocked with stated reasons, and the
  honest not-yet-intercepted list.
- Release plumbing: CI, tag-triggered `npm pack` into `dist/` with checksums,
  and a manual vhs demo re-render workflow.
