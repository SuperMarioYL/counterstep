/**
 * Fingerprint oracles (plan §2): sha256 digests over the pre-action state a
 * destructive op will touch.
 *
 *   - filesystem scopes (fingerprintPaths): a digest over every entry inside
 *     the scope — sorted relative paths, entry kinds, content digests — so
 *     edits, deletions and additions inside a scoped directory are all
 *     detectable as post-fire drift;
 *   - git remote refs (fingerprintRemoteRef): a digest of the remote ref's
 *     current target, read from the remote itself, never from a stale local
 *     remote-tracking ref.
 *
 * Both are pure functions of state content: they deliberately ignore
 * timestamps and inode noise, so a byte-identical restore reproduces the
 * armed fingerprint exactly. That equality is what the shadow rehearsal
 * (src/rehearse.ts) and the post-fire drift check (src/ledger.ts) rely on.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

const sha256 = (input: string | Buffer): string =>
  createHash("sha256").update(input).digest("hex");

/** Canonical forward-slashed relative form of a scope path. */
function normalizeRel(scope: string): string {
  const unified = scope.split(path.sep).join("/");
  return unified.replace(/\/+$/, "").replace(/^\.\//, "");
}

type EntryKind = "file" | "dir" | "symlink" | "special" | "absent";

interface ScopeEntry {
  rel: string;
  kind: EntryKind;
  /** Content digest; empty for kinds with no content of their own. */
  digest: string;
}

async function collectScope(root: string, rel: string, into: Map<string, ScopeEntry>): Promise<void> {
  const abs = path.join(root, rel);
  const st = await lstat(abs).catch(() => undefined);
  if (!st) {
    // an absent scope is fingerprintable state too (it records that the path
    // did not exist), it just carries no content
    into.set(rel, { rel, kind: "absent", digest: "" });
    return;
  }
  if (st.isSymbolicLink()) {
    into.set(rel, { rel, kind: "symlink", digest: sha256(await readlink(abs)) });
    return;
  }
  if (st.isDirectory()) {
    into.set(rel, { rel, kind: "dir", digest: "" });
    const names = (await readdir(abs)).sort();
    for (const name of names) {
      await collectScope(root, rel === "" ? name : `${rel}/${name}`, into);
    }
    return;
  }
  if (st.isFile()) {
    into.set(rel, { rel, kind: "file", digest: sha256(await readFile(abs)) });
    return;
  }
  into.set(rel, { rel, kind: "special", digest: "" });
}

/**
 * Fingerprint the filesystem state under `paths`, resolved relative to `root`,
 * recursively. Overlapping scopes are deduplicated; the digest is independent
 * of the order the scopes are given in.
 */
export async function fingerprintPaths(root: string, paths: string[]): Promise<string> {
  const entries = new Map<string, ScopeEntry>();
  for (const scope of [...paths].sort()) {
    await collectScope(root, normalizeRel(scope), entries);
  }
  const ordered = [...entries.values()].sort((a, b) =>
    a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0,
  );
  const hash = createHash("sha256");
  for (const entry of ordered) {
    hash.update(`${entry.kind}\0${entry.rel}\0${entry.digest}\n`);
  }
  return hash.digest("hex");
}

/**
 * Fingerprint the current target of `<remote> <ref>` as seen by the remote
 * itself (`git ls-remote`). A pure function of the ref target, so a shadow
 * clone sitting exactly on the inverse's sha carries the pre-action
 * fingerprint; an absent ref has its own stable digest.
 */
export async function fingerprintRemoteRef(root: string, remote: string, ref: string): Promise<string> {
  const { stdout } = await execa("git", ["ls-remote", remote, ref], { cwd: root });
  const target = stdout.split("\n")[0]?.split("\t")[0]?.trim() ?? "";
  return sha256(target === "" ? `absent ${ref}` : target);
}
