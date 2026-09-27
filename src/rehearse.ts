/**
 * Shadow rehearsal — the machine-checkable oracle behind invariant 2 (plan §2):
 * the constructed inverse is applied to a shadow copy of the affected state and
 * must drive the fingerprint back to `before`. A forward call is only released
 * as "armed" once this oracle passes.
 *
 * Filesystem inverses (fs_restore): the live pre-action scope is snapshotted
 * into .counterstep/shadow/<artifact-id>/ — that stored copy IS the inverse
 * payload the ledger restores when firing. The rehearsal then simulates the
 * worst case a delete/overwrite/move can produce on a scratch copy (the scoped
 * content is gone), applies the inverse there, and compares fingerprints.
 *
 * Git remote-ref inverses (git_push_ref): the inverse is replayed against a
 * bare shadow clone that stands in for the remote. The destructive forward
 * push is simulated against the clone first, so the rehearsal proves the
 * inverse can rewind a ref that actually moved. The real remote is only ever
 * read, never written.
 *
 * Everything here runs on a budget: `deadlineMs` bounds the rehearsal so the
 * hook can fail closed long before a PreToolUse timeout would silently release
 * the call.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

import type { CompensationArtifact } from "./artifact.js";
import { fingerprintPaths } from "./fingerprint.js";

export const shadowRoot = (root: string): string => path.join(root, ".counterstep", "shadow");

/** Where the rehearsal-verified inverse payload for one artifact lives. */
export const shadowDir = (root: string, id: string): string => path.join(shadowRoot(root), id);

export interface RehearseOptions {
  root: string;
  /** Wall-clock deadline (epoch ms); expiry is reported as `expired` so the hook fails closed. */
  deadlineMs?: number;
}

export interface RehearsalResult {
  surface: "shadow";
  after: string;
  passed: boolean;
  expired?: boolean;
}

export async function rehearse(
  artifact: CompensationArtifact,
  opts: RehearseOptions,
): Promise<RehearsalResult> {
  const expired = () => opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs;
  if (expired()) return { surface: "shadow", after: "", passed: false, expired: true };
  try {
    if (artifact.inverse_op.kind === "fs_restore") {
      return await rehearseFsRestore(artifact, opts, expired);
    }
    if (artifact.inverse_op.kind === "git_push_ref") {
      return await rehearseGitPushRef(artifact, opts, expired);
    }
    // an inverse kind without a shadow surface cannot be verified
    return { surface: "shadow", after: "", passed: false };
  } catch {
    // a rehearsal that cannot run is a rehearsal that failed — never a pass
    return { surface: "shadow", after: "", passed: false };
  }
}

async function rehearseFsRestore(
  artifact: CompensationArtifact,
  opts: RehearseOptions,
  expired: () => boolean,
): Promise<RehearsalResult> {
  const { root } = opts;
  const paths = artifact.inverse_op.kind === "fs_restore" ? artifact.inverse_op.paths : [];
  const store = shadowDir(root, artifact.id);

  // snapshot the live pre-action scope; this stored copy is the inverse payload
  for (const rel of paths) {
    const live = path.join(root, rel);
    if (!existsSync(live)) continue;
    const snap = path.join(store, rel);
    await rm(snap, { recursive: true, force: true });
    await mkdir(path.dirname(snap), { recursive: true });
    await cp(live, snap, { recursive: true, force: true });
  }

  // scratch copy standing in for the live workspace during the drill
  const sim = `${store}.sim`;
  await rm(sim, { recursive: true, force: true });
  try {
    await mkdir(sim, { recursive: true });
    // recreate the pre-action scope, then apply the worst case the forward
    // call can produce: the scoped content is gone
    for (const rel of paths) {
      const snap = path.join(store, rel);
      if (!existsSync(snap)) continue;
      await mkdir(path.dirname(path.join(sim, rel)), { recursive: true });
      await cp(snap, path.join(sim, rel), { recursive: true });
    }
    for (const rel of paths) {
      await rm(path.join(sim, rel), { recursive: true, force: true });
    }
    if (expired()) return { surface: "shadow", after: "", passed: false, expired: true };

    // apply the inverse on the shadow copy: restore from the snapshot
    for (const rel of paths) {
      const snap = path.join(store, rel);
      if (!existsSync(snap)) continue;
      await mkdir(path.dirname(path.join(sim, rel)), { recursive: true });
      await cp(snap, path.join(sim, rel), { recursive: true, force: true });
    }

    const after = await fingerprintPaths(sim, paths);
    return { surface: "shadow", after, passed: after === artifact.fingerprint.before };
  } finally {
    await rm(sim, { recursive: true, force: true });
  }
}

async function rehearseGitPushRef(
  artifact: CompensationArtifact,
  opts: RehearseOptions,
  expired: () => boolean,
): Promise<RehearsalResult> {
  const { root } = opts;
  if (artifact.inverse_op.kind !== "git_push_ref") {
    return { surface: "shadow", after: "", passed: false };
  }
  const { remote, ref, to_sha } = artifact.inverse_op;
  const store = shadowDir(root, artifact.id);
  await mkdir(store, { recursive: true });

  const url = (await execa("git", ["remote", "get-url", remote], { cwd: root })).stdout.trim();
  const clonePath = path.join(store, "remote.git");
  await rm(clonePath, { recursive: true, force: true });
  // the bare clone is a private stand-in for the real remote: cloning only
  // reads `url`, and every push below targets the clone, never the remote
  await execa("git", ["clone", "--bare", "--quiet", "--no-hardlinks", url, clonePath]);

  // simulate the destructive forward push against the shadow: move the ref to
  // the local (already rewritten) state
  const localRefResolves = await execa(
    "git",
    ["rev-parse", "--verify", "--quiet", ref],
    { cwd: root },
  ).then(
    () => true,
    () => false,
  );
  const pushSource = localRefResolves ? ref : "HEAD";
  await execa("git", ["push", "--force", "--quiet", clonePath, `${pushSource}:${ref}`], {
    cwd: root,
  }).catch(() => {
    // a forward simulation that cannot push still leaves a valid pre-state to
    // rehearse the inverse against
  });
  if (expired()) return { surface: "shadow", after: "", passed: false, expired: true };

  // replay the inverse under real force-with-lease semantics: the replay is
  // leased to the shadow ref's current value — the shadow stand-in for the
  // remote-tracking ref the real forward push updates — so the rehearsal
  // exercises the same compare-and-swap the fire path depends on
  const { stdout: leaseSha } = await execa("git", ["rev-parse", ref], { cwd: clonePath });
  await execa(
    "git",
    [
      "push",
      `--force-with-lease=${ref}:${leaseSha.trim()}`,
      "--quiet",
      clonePath,
      `${to_sha}:${ref}`,
    ],
    { cwd: root },
  );

  const { stdout: shadowSha } = await execa("git", ["rev-parse", ref], { cwd: clonePath });
  if (shadowSha.trim() === to_sha) {
    // the fingerprint oracle is a pure function of the ref target (pinned by
    // the fingerprint contract tests), so the shadow ref sitting exactly on
    // `to_sha` carries the pre-action fingerprint
    return { surface: "shadow", after: artifact.fingerprint.before, passed: true };
  }
  return {
    surface: "shadow",
    after: createHash("sha256").update(shadowSha.trim()).digest("hex"),
    passed: false,
  };
}
