#!/usr/bin/env node
/**
 * counterstep CLI (plan §3):
 *
 *   counterstep init     wire the Claude Code PreToolUse hook + state directory
 *   counterstep hook     stdio PreToolUse handler (what .claude/settings.json runs)
 *   counterstep ledger   review armed and fired compensation artifacts
 *   counterstep fire     execute an armed inverse by id, or --last
 *
 * One process per invocation, state is a directory: no daemon, no database.
 */
import { realpathSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";

import { wireClaudeCodeHook } from "./adapters/claude_code.js";
import { runHookStdio } from "./hook.js";
import { fireArtifact, listArtifacts } from "./ledger.js";
import type { CompensationArtifact } from "./artifact.js";

/**
 * Wire the repo for interception: install the hook entry and create the
 * .counterstep/ state directory (ledger + shadow store).
 */
export async function initCounterstep(repoRoot: string): Promise<void> {
  await wireClaudeCodeHook(repoRoot);
  await mkdir(path.join(repoRoot, ".counterstep", "shadow"), { recursive: true });
}

/** One-line description of the intercepted forward call. */
function describeCall(artifact: CompensationArtifact): string {
  const args = artifact.forward_call.args as Record<string, unknown>;
  if (artifact.forward_call.tool === "Bash" && typeof args.command === "string") {
    return args.command;
  }
  if (typeof args.file_path === "string") {
    return `${artifact.forward_call.tool} ${args.file_path}`;
  }
  return JSON.stringify(args);
}

/** One-line description of what firing the artifact does. */
function describeInverse(artifact: CompensationArtifact): string {
  const op = artifact.inverse_op;
  if (op.kind === "fs_restore") {
    return `restore ${op.paths.join(", ")} from the shadow snapshot`;
  }
  return `rewind ${op.remote} ${op.ref} to ${op.to_sha.slice(0, 12)}`;
}

async function runLedger(root: string): Promise<number> {
  const artifacts = await listArtifacts(root);
  if (artifacts.length === 0) {
    console.log("counterstep: the ledger is empty — destructive calls arm their inverse here");
    return 0;
  }
  for (const artifact of artifacts) {
    console.log(`${artifact.id}  ${artifact.status}  ${describeCall(artifact)}`);
    console.log(`  inverse: ${describeInverse(artifact)}`);
  }
  return 0;
}

async function runFire(root: string, id: string | undefined, last: boolean): Promise<number> {
  if (id === undefined && !last) {
    console.error("counterstep: give an artifact id or use --last");
    return 1;
  }
  try {
    const artifact = await fireArtifact(root, { id, last });
    if (artifact.status === "stale") {
      console.log(`counterstep: fired ${artifact.id}, but the scope drifted after arming — marked stale`);
      console.log("counterstep: the snapshot content was restored; inspect the drifted paths before re-arming");
      return 0;
    }
    console.log(`counterstep: fired ${artifact.id} — ${describeInverse(artifact)}`);
    console.log("counterstep: the affected scope matches the armed pre-action fingerprint");
    return 0;
  } catch (err) {
    console.error(`counterstep: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export function buildProgram(): Command {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  const program = new Command();
  program
    .name("counterstep")
    .description("A rehearsed undo ledger for developers running coding agents with write access")
    .version(pkg.version);

  program
    .command("init")
    .description("wire the Claude Code PreToolUse hook and create the state directory")
    .action(async () => {
      await initCounterstep(process.cwd());
      console.log("counterstep: PreToolUse hook wired into .claude/settings.json");
      console.log("counterstep: ledger + shadow store live in .counterstep/");
    });

  program
    .command("hook")
    .description("run the stdio PreToolUse hook (installed by init)")
    .action(async () => {
      process.exitCode = await runHookStdio();
    });

  program
    .command("ledger")
    .alias("list")
    .description("list armed and fired compensation artifacts")
    .action(async () => {
      process.exitCode = await runLedger(process.cwd());
    });

  program
    .command("fire")
    .description("fire an armed inverse and re-verify the fingerprint")
    .argument("[id]", "artifact id from the ledger")
    .option("--last", "fire the most recently armed artifact", false)
    .action(async (id: string | undefined, opts: { last: boolean }) => {
      process.exitCode = await runFire(process.cwd(), id, opts.last);
    });

  return program;
}

/* Run only when invoked as the binary, not when imported (tests, tooling). */
function isEntryModule(): boolean {
  try {
    const entry = process.argv[1] !== undefined ? realpathSync(process.argv[1]) : undefined;
    return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      console.error(`counterstep: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
