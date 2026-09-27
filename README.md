**English** | [简体中文](./README.zh-CN.md)

<div align="center">

# Counterstep

**A rehearsed undo ledger for developers running coding agents with write access.**

<img src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=600&size=20&pause=1400&color=58A6FF&center=true&vCenter=true&width=820&lines=Deny+until+armed.+Allow+only+when+the+undo+is+proven." alt="Deny until armed. Allow only when the undo is proven.">

<br>

<a href="https://github.com/SuperMarioYL/counterstep/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/SuperMarioYL/counterstep/ci.yml?label=CI" alt="CI"></a>
<a href="https://www.npmjs.com/package/counterstep"><img src="https://img.shields.io/npm/v/counterstep" alt="npm"></a>
<img src="https://img.shields.io/node/v/counterstep?label=node" alt="node">
<a href="./LICENSE"><img src="https://img.shields.io/github/license/SuperMarioYL/counterstep" alt="license"></a>
<img src="https://img.shields.io/badge/works%20with-Claude%20Code-58a6ff" alt="works with Claude Code">

<br>
<br>

*"My coding agent pushed a commit deleting every file on main" should never be a
point of no return. Counterstep arms a rehearsal-verified undo **before** every
destructive agent action, and gives you a one-key ledger to fire it when the
action turns out wrong.*

**Free and open source. No paid tier, no paywalled features.**

</div>

## How it works

Counterstep hooks into the tool-call path of your coding agent. When the agent
attempts something destructive — deleting files, overwriting an existing file,
force-pushing — the call is held until an undo for it exists and has been proven:

<table>
<tr>
<td width="33%" valign="top">

<br>

<p><img src="https://cdn.jsdelivr.net/npm/@tabler/icons@3/icons/outline/fingerprint.svg" width="22" height="22" alt="">&nbsp; <b>Fingerprint</b></p>

The affected state is hashed before anything runs: recursive content of the
filesystem scope, or the remote ref's current target read from the remote
itself.

</td>
<td width="33%" valign="top">

<br>

<p><img src="https://cdn.jsdelivr.net/npm/@tabler/icons@3/icons/outline/flask.svg" width="22" height="22" alt="">&nbsp; <b>Rehearse</b></p>

The constructed inverse is applied to a shadow copy and must drive the
fingerprint back to the pre-action value. No passing rehearsal, no release.

</td>
<td width="33%" valign="top">

<br>

<p><img src="https://cdn.jsdelivr.net/npm/@tabler/icons@3/icons/outline/bolt.svg" width="22" height="22" alt="">&nbsp; <b>Arm, then fire</b></p>

The call runs only once the inverse is armed in the ledger. If the outcome is
bad, <code>counterstep fire --last</code> executes the undo and re-verifies the
fingerprint.

</td>
</tr>
</table>

```
Claude Code ──PreToolUse (stdin JSON)──▶ counterstep hook
                                          ├─ classify: destructive class?
                                          ├─ construct inverse (fs | git adapter)
                                          ├─ fingerprint + shadow rehearsal (.counterstep/shadow/)
                                          └─ deny until armed; append .counterstep/ledger.jsonl
Developer ──▶ counterstep ledger / counterstep fire <id>   (verify fingerprint, execute inverse)
```

One npm-installed CLI. One process per hook invocation. State is a directory —
no daemon, no database.

## Quickstart

```bash
npm install -g counterstep

cd path/to/your/repo
counterstep init
```

`init` does two things: it wires the `PreToolUse` hook into
`.claude/settings.json` (merging into existing settings, idempotently), and it
creates the `.counterstep/` state directory — the ledger plus the shadow store
for rehearsal payloads. Add `.counterstep/` to your `.gitignore`.

From here, work with your agent as usual. The first time it attempts a
destructive op — `rm -rf src/legacy`, an overwrite of an existing file,
`git push --force origin main` — the hook fingerprints the state, constructs the
inverse, rehearses it against a shadow copy, and only then releases the call.
Typically seconds.

If the outcome is bad:

```bash
counterstep ledger        # review armed inverses and their fingerprints
counterstep fire --last   # execute the most recent undo, re-verified
```

Firing re-fingerprints the affected scope: the artifact is marked `fired` only
when the state is back exactly at the armed pre-action value, and `stale` when
live content drifted — drifted files are never silently clobbered, the restore
is a merge so you can inspect them first.

### Try it without an agent session

`examples/agent-call.sh` pipes the exact payload Claude Code sends, so you can
watch the interception from a plain shell:

```bash
./examples/agent-call.sh Bash "rm -rf src/legacy"   # what the hook sees
counterstep ledger
rm -rf src/legacy
counterstep fire --last
```

## Demo

<img src="docs/demo.gif" alt="A coding agent wipes src/legacy and force-pushes a deletion; both calls are armed through the hook and reversed one-key with counterstep fire --last" width="100%">

The session above is real: `src/legacy` comes back byte-identical, and the
force-pushed remote ref is rewound to the armed commit — an external side effect
no local snapshot or reflog can reach. Recorded with
[vhs](https://github.com/charmbracelet/vhs); the reproducible script is
[docs/demo.tape](docs/demo.tape).

## Why

**Approval is not recovery.** Harnesses gate the *decision* — an approve/deny
dialog, a sandbox. Once an approved destructive call executes, prevention has
nothing left to offer: there is no slot in an approval prompt for "here is the
armed inverse and its verified fingerprint". Counterstep owns the other half of
that handshake — the outcome.

**Snapshots are passive and local-only.** Time Machine and reflog help only if
a capture happened to precede the action, and nothing they capture reaches a
pushed commit. Counterstep forces the capture — tied to the exact destructive
call, fingerprint-checked — and its git inverse reaches remote refs that no
local snapshot can.

**The oracle is machine-checkable, not hopeful.** Saga compensation is decades
old; the import here is forcing it into agent tool calls with a rehearsal
oracle: the inverse must provably drive a shadow copy back to the pre-action
fingerprint before the forward call is allowed, and firing re-verifies against
live state.

**The boundary is stated, not hidden.** Ops with no constructible inverse —
third-party HTTP writes, `git reset --hard`, glob-targeted deletions — stay
blocked with the reason in the denial.
[docs/invertibility.md](docs/invertibility.md) classifies the full destructive
call surface, invertible and blocked alike.

## Ledger statuses

| Status | Meaning |
|---|---|
| `armed` | Inverse constructed, rehearsal passed, forward call released |
| `fired` | Undo executed; post-fire fingerprint matches the armed value |
| `stale` | Undo executed; live state drifted since arming — inspect before re-arming |
| `failed` | The inverse could not execute (e.g. a third-party commit landed under the lease); the remote was left untouched |

## Roadmap

- [v0.2 · intercept and invert](docs/invertibility.md#class-c--destructive-but-not-intercepted-in-v01) — `git clean`, `git checkout --`/`git restore`, and shell redirections, one oracle at a time
- [v0.2 · artifact format spec](docs/invertibility.md#the-inverse-oracles) — the artifact schema and the deny-until-armed handshake, published for harness and MCP tool authors
- [v0.3 · more harnesses](https://github.com/SuperMarioYL/counterstep/issues) — the adapter layer is one file per harness; Cursor, Codex CLI and Windsurf hooks follow the same shape

v0.1 intentionally covers the filesystem and git remote refs only —
[docs/invertibility.md](docs/invertibility.md) is the standing record of why,
and of everything else the ledger refuses with a stated reason.

## License

[MIT](./LICENSE) — free to use, modify, and ship.

<p align="center"><sub><a href="./LICENSE">MIT</a> © 2026 SuperMarioYL</sub></p>
