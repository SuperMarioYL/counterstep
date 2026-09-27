/**
 * The compensation ledger (plan §4): an append-only JSONL file at
 * .counterstep/ledger.jsonl with one artifact per line.
 *
 * Arming appends; firing advances the artifact's own line in place, so the
 * ledger holds exactly one line per artifact and list never folds history.
 *
 * Fire is the one-key path (plan §2 invariant 3): select by id or --last,
 * execute the inverse, then re-fingerprint the affected scope — `fired` only
 * when the scope is back exactly at the armed pre-action fingerprint, `stale`
 * on any drift, `failed` when the inverse itself could not execute. The fs
 * restore is a merge, never a clobber: only the paths the snapshot owns are
 * overwritten, so drifted content inside a scope survives firing for the
 * human to inspect.
 */
import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

import type { CompensationArtifact } from "./artifact.js";
import { fingerprintPaths, fingerprintRemoteRef } from "./fingerprint.js";
import { shadowDir } from "./rehearse.js";

const ledgerPath = (root: string): string => path.join(root, ".counterstep", "ledger.jsonl");

/** One JSON artifact per line; a torn line (crash mid-append) is skipped. */
function parseLine(line: string): CompensationArtifact | undefined {
  if (line.trim() === "") return undefined;
  try {
    return JSON.parse(line) as CompensationArtifact;
  } catch {
    return undefined;
  }
}

export async function appendArtifact(root: string, artifact: CompensationArtifact): Promise<void> {
  await mkdir(path.dirname(ledgerPath(root)), { recursive: true });
  await appendFile(ledgerPath(root), `${JSON.stringify(artifact)}\n`, "utf8");
}

export async function listArtifacts(root: string): Promise<CompensationArtifact[]> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath(root), "utf8");
  } catch {
    return []; // no ledger yet: an empty ledger, not an error
  }
  return raw
    .split("\n")
    .map(parseLine)
    .filter((artifact): artifact is CompensationArtifact => artifact !== undefined);
}

export async function getArtifact(root: string, id: string): Promise<CompensationArtifact | undefined> {
  return (await listArtifacts(root)).find((artifact) => artifact.id === id);
}

/** Rewrite the fired artifact's own line, leaving every other line untouched. */
async function persistArtifact(root: string, updated: CompensationArtifact): Promise<void> {
  const lines = (await readFile(ledgerPath(root), "utf8")).split("\n");
  const rewritten = lines
    .map((line) => (parseLine(line)?.id === updated.id ? JSON.stringify(updated) : line))
    .join("\n");
  await writeFile(ledgerPath(root), rewritten, "utf8");
}

export interface FireSelector {
  /** Fire this exact artifact id. */
  id?: string;
  /** Fire the most recently armed artifact (`counterstep fire --last`). */
  last?: boolean;
}

async function selectArtifact(
  artifacts: CompensationArtifact[],
  selector: FireSelector,
): Promise<CompensationArtifact> {
  if (selector.id !== undefined) {
    const found = artifacts.find((artifact) => artifact.id === selector.id);
    if (!found) throw new Error(`counterstep: no artifact ${selector.id} in the ledger`);
    return found;
  }
  // append order is arm order, so the most recently armed artifact is the
  // last armed line in the file
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const candidate = artifacts[i];
    if (candidate?.status === "armed") return candidate;
  }
  throw new Error("counterstep: no armed artifact to fire");
}

/** Replay an fs_restore inverse: merge the shadow snapshot back over the live scope. */
async function restoreFromShadow(root: string, artifact: CompensationArtifact): Promise<void> {
  if (artifact.inverse_op.kind !== "fs_restore") return;
  const store = shadowDir(root, artifact.id);
  for (const rel of artifact.inverse_op.paths) {
    const snap = path.join(store, rel);
    if (!existsSync(snap)) continue; // nothing was snapshotted for this path
    const live = path.join(root, rel);
    await mkdir(path.dirname(live), { recursive: true });
    await cp(snap, live, { recursive: true, force: true });
  }
}

/**
 * Fire one armed inverse and re-verify the fingerprint (plan §2 invariant 3).
 * Returns the artifact with its final status: `fired` when the affected scope
 * is back exactly at the armed pre-action fingerprint, `stale` when live
 * state drifted, `failed` when the inverse could not execute.
 */
export async function fireArtifact(root: string, selector: FireSelector): Promise<CompensationArtifact> {
  const artifact = await selectArtifact(await listArtifacts(root), selector);
  if (artifact.status !== "armed") {
    throw new Error(`counterstep: artifact ${artifact.id} is ${artifact.status}; only armed artifacts can fire`);
  }

  const updated: CompensationArtifact = { ...artifact };
  try {
    if (artifact.inverse_op.kind === "fs_restore") {
      await restoreFromShadow(root, artifact);
    } else {
      // the post-fire fingerprint below is the lease: the rewind must land on
      // the armed sha or the artifact is marked stale
      const inverse = artifact.inverse_op;
      await execa(
        "git",
        ["push", "--force", "--quiet", inverse.remote, `${inverse.to_sha}:${inverse.ref}`],
        { cwd: root },
      );
    }
  } catch (err) {
    updated.status = "failed";
    await persistArtifact(root, updated);
    throw err instanceof Error ? err : new Error(String(err));
  }

  const after =
    artifact.inverse_op.kind === "fs_restore"
      ? await fingerprintPaths(root, artifact.inverse_op.paths)
      : await fingerprintRemoteRef(root, artifact.inverse_op.remote, artifact.inverse_op.ref);
  updated.status = after === artifact.fingerprint.before ? "fired" : "stale";
  await persistArtifact(root, updated);
  return updated;
}
