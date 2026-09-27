# Invertibility: what a coding agent can and cannot undo

Counterstep is governed by one rule: a destructive call in the intercepted class
stays blocked until an inverse is constructed, fingerprinted, and proven on a
shadow copy. Ops that cannot satisfy that oracle are never waved through — they
are denied with the reason stated. This document is the standing classification
of the destructive call surface v0.1 sees through the Claude Code adapter, and
the scoping input for v0.2.

## Method

The surface enumerated here is the one `counterstep init` actually wires: the
Claude Code `PreToolUse` hook over `Bash`, `Write`, `Edit`, `MultiEdit` and
`NotebookEdit` calls. Every entry below is classified against the implemented
mechanism — the inverse constructors (`src/compensation.ts`), the fingerprint
oracles (`src/fingerprint.ts`), and the shadow rehearsal (`src/rehearse.ts`) —
not against intent. The falsifier question from the plan is answered in the
verdict section.

## The inverse oracles

An op is invertible only when both halves exist:

- a **machine-executable inverse** — `fs_restore` (a shadow snapshot of the
  affected paths, stored under `.counterstep/shadow/<artifact-id>/`) or
  `git_push_ref` (`git push --force-with-lease <old-sha>:<ref>`);
- a **fingerprint oracle** — a sha256 over the pre-action state the op touches:
  recursive content of filesystem scopes, or the remote ref's current target
  read from the remote itself.

## Class A — intercepted and invertible (armed, then allowed)

| # | Destructive call | Inverse | Rehearsal surface |
|---|---|---|---|
| 1 | `rm <file>` | `fs_restore` of the file | snapshot restored on a scratch copy |
| 2 | `rm -f <file>` | `fs_restore` | same |
| 3 | `rm -r <dir>` | `fs_restore` of the directory | same |
| 4 | `rm -rf <dir>` | `fs_restore` of the directory | same |
| 5 | `rm` with several literal paths | `fs_restore` of every existing target | same |
| 6 | `mv <src> <dst>` (rename) | `fs_restore` of the source | same |
| 7 | `mv <src> <dst>` (clobbers an existing dst) | `fs_restore` of source + destination | same |
| 8 | `mv <src> <dir>/` | `fs_restore` of the source | same |
| 9 | `Write` overwriting an existing file | `fs_restore` of that file | same |
| 10 | `Edit` on an existing file | `fs_restore` of that file | same |
| 11 | `MultiEdit` on an existing file | `fs_restore` of that file | same |
| 12 | `NotebookEdit` on an existing notebook | `fs_restore` of that file | same |
| 13 | `git push --force <remote> <ref>` | `git_push_ref` back to the remote's current sha | replayed against a bare shadow clone |
| 14 | `git push -f` / `--force-with-lease <remote> <ref>` | `git_push_ref` | same |
| 15 | `git push <remote> :<ref>` (deletes a remote ref, forced) | `git_push_ref` to the prior target | same |

## Class B — intercepted, blocked with the reason stated

| # | Destructive call | Why no inverse is armed |
|---|---|---|
| 16 | `rm -f src/**/*.log` (any glob target) | what the shell will expand is unknowable before execution; no fingerprint oracle can cover it |
| 17 | `mv *.bak archive/` | same |
| 18 | `rm /tmp/notes`, `mv x ../y` (outside the workspace) | outside every oracle's scope |
| 19 | `rm .counterstep/` | counterstep's own state directory |
| 20 | `git push --force` (no `<remote> <refspec>`) | cannot tell which remote ref an inverse should restore |
| 21 | `git push --force origin HEAD` | the refspec names no single remote ref |
| 22 | `git push --force origin new-branch` (ref absent on the remote) | the push creates the ref; there is no prior target to restore |
| 23 | `git reset --hard` | discards uncommitted working-tree and index state across the whole repository at once; no scoped, rehearsal-verifiable inverse |
| 24 | `curl -X POST/PUT/PATCH/DELETE ...` | third-party HTTP writes: no inverse constructor in v0.1 (filesystem and git remote refs only) |
| 25 | `curl -d @payload.json`, `-F`, `-T`, `--post-data` | same |
| 26 | `wget --post-data/--post-file` | same |
| 27 | `http POST api.example.com/items` (HTTPie verbs) | same |

## Class C — destructive but not intercepted in v0.1

These run through the harness's normal permission flow — nothing arms an
inverse for them yet. They are documented here deliberately: this column is the
v0.2 backlog, not a claim of coverage.

| # | Destructive call | Note |
|---|---|---|
| 28 | `git clean -fd(x)` | deletes untracked files; a dry-run enumeration would feed an `fs_restore` (v0.2 candidate) |
| 29 | `git checkout -- <paths>` / `git restore` | discards uncommitted changes; same shape as Class A file restores |
| 30 | `git branch -D <branch>` | local-only; reflog-reachable while it exists |
| 31 | `git rebase` / `git commit --amend` | local history rewrite; reflog-reachable; the remote side is covered if pushed through an intercepted push |
| 32 | `git filter-repo` / `filter-branch` | history rewrite; the subsequent forced push lands in the intercepted class |
| 33 | `git gc --prune=now` | destroys unreachable objects; rare and reflog-dependent |
| 34 | `git remote remove <name>` | config-only, recoverable by re-adding |
| 35 | `> file` (redirection truncation) | shell redirections are invisible to tool-name classification |
| 36 | `truncate -s 0 <file>` | not classified; same oracle would apply |
| 37 | `find <path> -delete` | not classified |
| 38 | `dd of=<file>` | not classified |
| 39 | `chmod`/`chown -R` | metadata-only damage; needs a metadata oracle |
| 40 | `npm publish`, `twine upload` | third-party publishes; blocked-class intent, no oracle yet |
| 41 | `kubectl delete`, `terraform destroy` | infrastructure inverses are out of scope for v0.1 |

## Verdict

The ops agents actually run most often — deleting, moving, overwriting files,
and force-pushing — all admit mechanically constructible, rehearsal-verifiable
inverses, and they are the entire armed surface of v0.1. The long tail splits
into ops that are intercepted but honestly refused (Class B, with the reason in
the denial) and ops not yet intercepted at all (Class C, enumerated so the gap
is explicit rather than implied).

Against the plan's kill criterion — fewer than half of high-severity ops with a
mechanically constructible, rehearsal-verifiable inverse — the classification
holds for the high-frequency class and fails for the shell-level tail
(redirections, `find -delete`, `git clean`). The honest reading: the primitive
is worth its complexity for filesystem and git-remote damage; expanding toward
Class C is scoped by demand, one oracle at a time.
