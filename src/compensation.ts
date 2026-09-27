/**
 * Inverse construction (plan §4): given an intercepted destructive forward
 * call, build the machine-executable compensation the ledger can arm, or state
 * the reason the op must stay blocked. Invariant 4 (plan §2): ops with no
 * constructible inverse or no fingerprint oracle never pass silently — they
 * come back blocked with the reason stated.
 *
 * v0.1 covers the filesystem and git remote refs only. Third-party HTTP writes
 * and whole-repo git resets have no scoped, rehearsal-verifiable inverse here;
 * docs/invertibility.md tracks the full classification.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";

import type { InverseOp } from "./artifact.js";

export type InversePlan = { inverse_op: InverseOp } | { blocked: string };

export interface ConstructOptions {
  root: string;
}

interface ForwardCall {
  tool: string;
  args: Record<string, unknown>;
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

/** Forward-slash form of `target` resolved inside `root`. */
function toRel(target: string, root: string): string {
  const abs = path.resolve(root, target);
  return path.relative(root, abs).split(path.sep).join("/");
}

/**
 * Gate every scoped path through the same limits the hook enforces: the
 * inverse can only cover state inside the workspace and outside counterstep's
 * own directory, and never a shell glob — what the shell expands is not
 * knowable before execution, so no fingerprint oracle can cover it.
 */
function fsGuard(target: string, root: string): { ok: true; rel: string } | { ok: false; reason: string } {
  const rel = toRel(target, root);
  const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  if (!inside) {
    return {
      ok: false,
      reason: `${target} is outside the counterstep workspace; no fingerprint oracle can cover it, so the call stays blocked`,
    };
  }
  if (rel === ".counterstep" || rel.startsWith(".counterstep/")) {
    return {
      ok: false,
      reason: `${target} is counterstep's own state directory; arming an inverse for it is not supported`,
    };
  }
  return { ok: true, rel };
}

/** Shell glob metacharacters: what the shell expands is unknowable pre-run. */
function hasGlobMeta(target: string): boolean {
  return /[*?[]/.test(target);
}

function constructRm(tokens: string[], root: string): InversePlan {
  const targets = positionalArgs(tokens);
  const paths: string[] = [];
  for (const target of targets) {
    const guard = fsGuard(target, root);
    if (!guard.ok) return { blocked: guard.reason };
    if (hasGlobMeta(target)) {
      return {
        blocked: `${target} contains shell glob metacharacters; counterstep cannot fingerprint what the shell will expand, so the call stays blocked`,
      };
    }
    if (existsSync(path.join(root, guard.rel))) paths.push(guard.rel);
  }
  if (paths.length === 0) {
    return {
      blocked: "rm names no existing path inside the workspace, so there is no state to arm an inverse for",
    };
  }
  return { inverse_op: { kind: "fs_restore", paths } };
}

function constructMv(tokens: string[], root: string): InversePlan {
  const args = positionalArgs(tokens);
  if (args.length < 2) {
    return {
      blocked: "mv without a source and a destination; counterstep cannot tell what state the move would destroy",
    };
  }
  const sources = args.slice(0, -1);
  const dest = args[args.length - 1]!;
  const paths: string[] = [];
  for (const target of [...sources, dest]) {
    const guard = fsGuard(target, root);
    if (!guard.ok) return { blocked: guard.reason };
    if (hasGlobMeta(target)) {
      return {
        blocked: `${target} contains shell glob metacharacters; counterstep cannot fingerprint what the shell will expand, so the call stays blocked`,
      };
    }
    // a move destroys its sources and clobbers the destination when it exists
    if (existsSync(path.join(root, guard.rel))) paths.push(guard.rel);
  }
  if (paths.length === 0) {
    return {
      blocked: "mv touches no existing path inside the workspace, so there is no state to arm an inverse for",
    };
  }
  return { inverse_op: { kind: "fs_restore", paths } };
}

/**
 * Full remote ref for a push refspec: the remote side of `src:dst`, branches
 * by default. A bare `HEAD` refspec names no remote ref, so it is not
 * invertible.
 */
function remoteRefOf(refspec: string): string | undefined {
  const remoteSide = refspec.includes(":") ? (refspec.split(":")[1] ?? "") : refspec;
  if (remoteSide === "" || remoteSide === "HEAD") return undefined;
  if (remoteSide.startsWith("refs/")) return remoteSide;
  return `refs/heads/${remoteSide}`;
}

/** Current target of `<remote> <ref>`, read from the remote itself. */
async function remoteTarget(root: string, remote: string, ref: string): Promise<string | undefined> {
  const { stdout } = await execa("git", ["ls-remote", remote, ref], { cwd: root });
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  const exact = lines.find((line) => line.split("\t")[1]?.trim() === ref);
  const sha = (exact ?? lines[0])?.split("\t")[0]?.trim();
  return sha === "" || sha === undefined ? undefined : sha;
}

async function constructGitPush(tokens: string[], root: string): Promise<InversePlan> {
  const rest: string[] = [];
  for (const tok of tokens.slice(2)) {
    if (!tok.startsWith("-")) rest.push(tok);
  }
  if (rest.length < 2) {
    return {
      blocked:
        "git push --force without an explicit <remote> <refspec>; counterstep cannot tell which remote ref an inverse should restore",
    };
  }
  const remote = rest[0]!;
  const ref = remoteRefOf(rest[1]!);
  if (ref === undefined) {
    return {
      blocked:
        "the push refspec does not name a single remote ref; counterstep cannot tell which ref an inverse should restore",
    };
  }
  let toSha: string | undefined;
  try {
    toSha = await remoteTarget(root, remote, ref);
  } catch (err) {
    return {
      blocked: `counterstep could not read ${ref} from ${remote} (${
        err instanceof Error ? err.message : String(err)
      }); the call stays blocked`,
    };
  }
  if (toSha === undefined) {
    return {
      blocked: `${remote} has no ${ref} yet; the push would create the ref rather than destroy tracked state, and there is no prior target to restore`,
    };
  }
  return { inverse_op: { kind: "git_push_ref", remote, ref, to_sha: toSha } };
}

function constructHttpWrite(cmd: string): InversePlan {
  return {
    blocked: `${cmd} writes to a third-party service; v0.1 has no inverse constructor for HTTP writes (filesystem and git remote refs only), so the call stays blocked — see docs/invertibility.md`,
  };
}

function constructGitResetHard(): InversePlan {
  return {
    blocked:
      "git reset --hard discards uncommitted working-tree and index state across the whole repository at once; v0.1 has no scoped, rehearsal-verifiable inverse for it, so the call stays blocked — see docs/invertibility.md",
  };
}

/**
 * Mirror of the hook's classification for HTTP tools: only write-shaped calls
 * are in the destructive class, so read-only requests keep passing through.
 */
function isHttpWriteSegment(tokens: string[]): boolean {
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
  return writeFlag || writeMethod || httpieWriteVerb;
}

/**
 * Plan for one command segment, or undefined when the segment is outside the
 * destructive class. The first segment with a plan decides the outcome — the
 * same first-non-safe rule the hook classifies with, so a destructive piece
 * cannot hide behind a harmless prefix.
 */
async function constructSegment(tokens: string[], root: string): Promise<InversePlan | undefined> {
  const cmd = (tokens[0] ?? "").split("/").pop() ?? "";
  if (cmd === "rm") return constructRm(tokens, root);
  if (cmd === "mv") return constructMv(tokens, root);
  if (cmd === "git") {
    const sub = tokens[1] ?? "";
    if (sub === "push") return constructGitPush(tokens, root);
    if (sub === "reset" && tokens.includes("--hard")) return constructGitResetHard();
    return undefined;
  }
  if (cmd === "curl" || cmd === "wget" || cmd === "http" || cmd === "https") {
    return isHttpWriteSegment(tokens) ? constructHttpWrite(cmd) : undefined;
  }
  return undefined;
}

function constructFileOverwrite(call: ForwardCall, root: string): InversePlan {
  const filePath = typeof call.args.file_path === "string" ? call.args.file_path : "";
  if (filePath === "") {
    return { blocked: "the write names no file_path; counterstep cannot scope an inverse" };
  }
  const guard = fsGuard(filePath, root);
  if (!guard.ok) return { blocked: guard.reason };
  return { inverse_op: { kind: "fs_restore", paths: [guard.rel] } };
}

/**
 * Construct the inverse for an intercepted forward call. Returns either an
 * inverse operation the hook can fingerprint, snapshot and rehearse, or the
 * stated reason the call stays blocked.
 */
export async function constructInverse(
  call: ForwardCall,
  opts: ConstructOptions,
): Promise<InversePlan> {
  const root = opts.root;
  if (call.tool === "Bash") {
    const command = typeof call.args.command === "string" ? call.args.command : "";
    for (const segment of command.split(/&&|;|\||\n/)) {
      const tokens = segment.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue;
      const plan = await constructSegment(tokens, root);
      if (plan !== undefined) return plan;
    }
    return {
      blocked:
        "counterstep classified this call as destructive but found no destructive segment to invert; the call stays blocked",
    };
  }
  if (call.tool === "Write" || call.tool === "Edit" || call.tool === "MultiEdit" || call.tool === "NotebookEdit") {
    return constructFileOverwrite(call, root);
  }
  return {
    blocked: `counterstep v0.1 has no inverse constructor for tool ${call.tool}; the call stays blocked — see docs/invertibility.md`,
  };
}
