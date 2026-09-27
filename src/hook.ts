/**
 * Counterstep PreToolUse hook (plan §3 step 4, §4).
 *
 * One constraint shapes this file: a PreToolUse hook that exceeds its timeout
 * does NOT block the call — the harness falls back to the normal permission
 * flow and the tool runs anyway. Rehearsal therefore runs on a budget well
 * under the hook timeout, and the hook fails CLOSED: if the budget expires it
 * denies with a re-run instruction instead of letting a timeout silently
 * release a destructive call.
 *
 * Pipeline for a classified-destructive call:
 *   construct inverse -> fingerprint the pre-action state -> shadow rehearsal
 *   -> append the armed artifact to the ledger -> allow.
 * Ops with no constructible inverse stay denied with the reason stated; a
 * rehearsal that cannot be verified never releases the call.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { constructInverse } from "./compensation.js";
import { fingerprintPaths, fingerprintRemoteRef } from "./fingerprint.js";
import { appendArtifact } from "./ledger.js";
import { rehearse } from "./rehearse.js";
import { newArtifactId, type CompensationArtifact, type InverseOp } from "./artifact.js";
import { parsePreToolUse, renderDecision } from "./adapters/claude_code.js";

/**
 * Rehearsal budget, deliberately well under the PreToolUse hook timeout: when
 * the budget is gone we deny and ask for a re-run rather than racing the
 * harness timeout and losing.
 */
export const DEFAULT_BUDGET_MS = 8_000;

export interface HookEvent {
  tool: string;
  args: Record<string, unknown>;
}

export interface HandleHookOptions {
  root: string;
  budgetMs?: number;
}

export interface HookDecision {
  decision: "allow" | "deny";
  reason?: string;
}

type Classification =
  | { kind: "safe" }
  | { kind: "candidate" } // destructive candidate; constructInverse decides invertibility
  | { kind: "blocked"; reason: string }; // destructive but outside every fingerprint oracle

/** True when `abs` is strictly inside `root`. */
function insideRoot(abs: string, root: string): boolean {
  const rel = path.relative(root, abs);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Guard one path target: it must resolve strictly inside the workspace and
 * outside counterstep's own state directory. The state exclusion also keeps a
 * snapshot from copying the shadow store into itself.
 */
function fsGuard(target: string, root: string): { ok: true; rel: string } | { ok: false; reason: string } {
  const abs = path.resolve(root, target);
  const rel = path.relative(root, abs);
  if (!insideRoot(abs, root)) {
    return {
      ok: false,
      reason: `${target} is outside the counterstep workspace; no fingerprint oracle can cover it, so the call stays blocked`,
    };
  }
  if (rel === ".counterstep" || rel.startsWith(`.counterstep${path.sep}`)) {
    return {
      ok: false,
      reason: `${target} is counterstep's own state directory; arming an inverse for it is not supported`,
    };
  }
  return { ok: true, rel };
}

/** Non-flag arguments of a tokenized command, honouring the `--` terminator. */
function positionalArgs(tokens: string[]): string[] {
  const out: string[] = [];
  let endOfFlags = false;
  for (const tok of tokens.slice(1)) {
    if (!endOfFlags && tok === "--") {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && tok.startsWith("-") && tok !== "-") continue;
    out.push(tok);
  }
  return out;
}

/** Shell glob metacharacters: what the shell expands is unknowable pre-run. */
function hasGlobMeta(target: string): boolean {
  return /[*?[]/.test(target);
}

function classifyRm(tokens: string[], root: string): Classification {
  const targets = positionalArgs(tokens);
  let affected = false;
  for (const target of targets) {
    const guard = fsGuard(target, root);
    if (!guard.ok) return { kind: "blocked", reason: guard.reason };
    if (hasGlobMeta(target)) {
      return {
        kind: "blocked",
        reason: `${target} contains shell glob metacharacters; counterstep cannot fingerprint what the shell will expand, so the call stays blocked`,
      };
    }
    if (existsSync(path.join(root, guard.rel))) affected = true;
  }
  // rm of paths that do not exist destroys nothing
  return affected ? { kind: "candidate" } : { kind: "safe" };
}

function classifyMv(tokens: string[], root: string): Classification {
  const args = positionalArgs(tokens);
  if (args.length < 2) return { kind: "safe" };
  const sources = args.slice(0, -1);
  const dest = args[args.length - 1]!;
  for (const target of [...sources, dest]) {
    const guard = fsGuard(target, root);
    if (!guard.ok) return { kind: "blocked", reason: guard.reason };
    if (hasGlobMeta(target)) {
      return {
        kind: "blocked",
        reason: `${target} contains shell glob metacharacters; counterstep cannot fingerprint what the shell will expand, so the call stays blocked`,
      };
    }
    // a move destroys its source, and clobbers the destination when it exists
    if (existsSync(path.join(root, guard.rel))) return { kind: "candidate" };
  }
  return { kind: "safe" };
}

function classifyGit(tokens: string[], root: string): Classification {
  const sub = tokens[1] ?? "";
  if (sub === "push") {
    let forced = false;
    let dryRun = false;
    const rest: string[] = [];
    for (const tok of tokens.slice(2)) {
      if (tok === "-f" || tok.startsWith("--force")) {
        forced = true;
        continue;
      }
      if (tok === "--dry-run" || tok === "-n") {
        dryRun = true;
        continue;
      }
      if (tok.startsWith("-")) continue; // -u, --set-upstream, ...
      rest.push(tok);
    }
    if (!forced || dryRun) return { kind: "safe" }; // plain pushes are outside the v0.1 destructive class
    if (rest.length < 2) {
      return {
        kind: "blocked",
        reason:
          "git push --force without an explicit <remote> <refspec>; counterstep cannot tell which remote ref an inverse should restore",
      };
    }
    return { kind: "candidate" };
  }
  if (sub === "reset" && tokens.includes("--hard")) {
    return { kind: "candidate" };
  }
  return { kind: "safe" };
}

function classifyHttpTool(tokens: string[]): Classification {
  const writeFlag = tokens
    .slice(1)
    .some(
      (t) =>
        t === "-d" ||
        t.startsWith("--data") ||
        t === "-F" ||
        t.startsWith("--form") ||
        t === "-T" ||
        t.startsWith("--upload-file") ||
        t.startsWith("--post-data") ||
        t.startsWith("--post-file"),
    );
  let method = "";
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === "-X" || tok === "--request" || tok === "--method") {
      method = (tokens[i + 1] ?? "").toUpperCase();
    }
  }
  const writeMethod = method !== "" && !["GET", "HEAD", "OPTIONS"].includes(method);
  const cmd = (tokens[0] ?? "").split("/").pop() ?? "";
  const httpieWriteVerb =
    (cmd === "http" || cmd === "https") && /^(POST|PUT|PATCH|DELETE)$/i.test(tokens[1] ?? "");
  return writeFlag || writeMethod || httpieWriteVerb ? { kind: "candidate" } : { kind: "safe" };
}

function classifyBashSegment(tokens: string[], root: string): Classification {
  const cmd = (tokens[0] ?? "").split("/").pop() ?? "";
  if (cmd === "rm") return classifyRm(tokens, root);
  if (cmd === "mv") return classifyMv(tokens, root);
  if (cmd === "git") return classifyGit(tokens, root);
  if (cmd === "curl" || cmd === "wget" || cmd === "http" || cmd === "https") {
    return classifyHttpTool(tokens);
  }
  return { kind: "safe" };
}

function classifyCall(event: HookEvent, root: string): Classification {
  switch (event.tool) {
    case "Bash": {
      const command = typeof event.args.command === "string" ? event.args.command : "";
      // chained commands are classified segment by segment so a destructive
      // piece cannot hide behind a harmless prefix
      for (const segment of command.split(/&&|;|\||\n/)) {
        const tokens = segment.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0) continue;
        const cls = classifyBashSegment(tokens, root);
        if (cls.kind !== "safe") return cls;
      }
      return { kind: "safe" };
    }
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const filePath = typeof event.args.file_path === "string" ? event.args.file_path : "";
      if (!filePath) return { kind: "safe" };
      const abs = path.resolve(root, filePath);
      if (!insideRoot(abs, root)) {
        return {
          kind: "blocked",
          reason: `${filePath} is outside the counterstep workspace; no fingerprint oracle can cover it, so the call stays blocked`,
        };
      }
      // creating a new file destroys nothing; overwriting an existing one does
      if (!existsSync(abs)) return { kind: "safe" };
      return { kind: "candidate" };
    }
    default:
      return { kind: "safe" };
  }
}

function describeScope(inverse: InverseOp): string {
  return inverse.kind === "fs_restore"
    ? `fs:${inverse.paths.join(",")}`
    : `git-remote:${inverse.remote} ${inverse.ref}`;
}

/**
 * Handle one tool call. Non-destructive calls pass through untouched; a
 * destructive call is denied until its inverse is armed with a passing shadow
 * rehearsal, at which point the artifact lands in the ledger and the call is
 * released.
 */
export async function handleHookEvent(event: HookEvent, opts: HandleHookOptions): Promise<HookDecision> {
  const classification = classifyCall(event, opts.root);
  if (classification.kind === "safe") return { decision: "allow" };
  if (classification.kind === "blocked") return { decision: "deny", reason: classification.reason };

  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const expired = () => Date.now() >= deadline;
  const budgetDenial = (): HookDecision => ({
    decision: "deny",
    reason:
      "counterstep rehearsal budget expired before an inverse could be armed, so the call is denied fail-closed; re-run the call to retry arming (a PreToolUse hook that outlives its timeout would not block the call at all)",
  });

  try {
    if (expired()) return budgetDenial();

    const forwardCall = { tool: event.tool, args: event.args };
    const plan = await constructInverse(forwardCall, { root: opts.root });
    if ("blocked" in plan) return { decision: "deny", reason: plan.blocked };
    if (expired()) return budgetDenial();

    // the fingerprint scope is exactly the inverse's scope, so the rehearsal
    // oracle and the post-fire drift check compare like with like
    const inverse = plan.inverse_op;
    const before =
      inverse.kind === "fs_restore"
        ? await fingerprintPaths(opts.root, inverse.paths)
        : await fingerprintRemoteRef(opts.root, inverse.remote, inverse.ref);
    if (expired()) return budgetDenial();

    const artifact: CompensationArtifact = {
      id: newArtifactId(),
      forward_call: forwardCall,
      inverse_op: inverse,
      fingerprint: { scope: describeScope(inverse), before },
      rehearsal: { surface: "shadow", after: "", passed: false },
      status: "armed",
    };
    const rehearsal = await rehearse(artifact, { root: opts.root, deadlineMs: deadline });
    if (rehearsal.expired) return budgetDenial();
    if (!rehearsal.passed) {
      return {
        decision: "deny",
        reason:
          "counterstep could not verify the constructed inverse on the shadow copy; the destructive call stays blocked — re-run it to retry",
      };
    }
    artifact.rehearsal = { surface: "shadow", after: rehearsal.after, passed: true };
    await appendArtifact(opts.root, artifact);
    console.error(
      `counterstep: armed ${artifact.id} (${inverse.kind}) — "counterstep ledger" to review, "counterstep fire --last" to undo`,
    );
    return { decision: "allow" };
  } catch (err) {
    // arming blew up: never release the call on our own failure
    return {
      decision: "deny",
      reason: `counterstep failed while arming an inverse (${
        err instanceof Error ? err.message : String(err)
      }); the destructive call stays blocked — re-run it to retry`,
    };
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Stdio entry wired by `counterstep hook`: reads the Claude Code PreToolUse
 * payload from stdin, prints the hook decision as JSON, and exits 2 with the
 * reason on stderr for every denial (exit code 2 is what makes the harness
 * block the call).
 */
export async function runHookStdio(): Promise<number> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    // an unparseable payload is not evidence of destructiveness; pass through
    console.error("counterstep: unparseable hook payload; passing the call through");
    return 0;
  }
  const event = parsePreToolUse(payload as { tool_name?: string; tool_input?: unknown });
  let decision: HookDecision;
  try {
    decision = await handleHookEvent(event, { root: process.cwd() });
  } catch (err) {
    decision = {
      decision: "deny",
      reason: `counterstep hook error (${err instanceof Error ? err.message : String(err)}); re-run the call to retry`,
    };
  }
  process.stdout.write(`${JSON.stringify(renderDecision(decision))}\n`);
  if (decision.decision === "deny") {
    console.error(`counterstep: ${decision.reason ?? "denied"}`);
    return 2;
  }
  return 0;
}
