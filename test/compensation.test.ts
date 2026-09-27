/**
 * Contract tests for the compensation core (plan §2).
 *
 * Under test:
 *   - src/fingerprint.ts  sha256 oracle over filesystem scopes and git remote refs
 *   - src/compensation.ts inverse construction for the destructive class
 *   - src/rehearse.ts     shadow-copy rehearsal of constructed inverses
 *   - src/ledger.ts       append-only JSONL ledger: append / list / fire / stale detection
 *
 * Invariants pinned here (plan §2):
 *   1. a destructive forward call stays blocked until an artifact with
 *      `rehearsal.passed === true` exists in the ledger;
 *   2. the rehearsal oracle is machine-checkable: applying the inverse to a
 *      shadow copy must drive the fingerprint back to `before`;
 *   3. firing re-verifies the fingerprint and marks the artifact `stale`
 *      instead of `fired` when live state drifted;
 *   4. ops with no constructible inverse stay blocked with the reason stated.
 */
import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";

import { fingerprintPaths, fingerprintRemoteRef } from "../src/fingerprint";
import { constructInverse } from "../src/compensation";
import { rehearse } from "../src/rehearse";
import { appendArtifact, fireArtifact, getArtifact, listArtifacts } from "../src/ledger";
import { handleHookEvent } from "../src/hook";

const SHA256_HEX = /^[0-9a-f]{64}$/;

async function tempDir(prefix: string, t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeTree(root: string, entries: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(entries)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

/** True when `paths` scopes `target` exactly or through a parent directory. */
function covers(paths: string[], target: string): boolean {
  return paths.some((p) => p === target || target.startsWith(p.replace(/\/+$/, "") + "/"));
}

interface GitFixture {
  repo: string;
  origin: string;
  remoteSha(): Promise<string>;
  commitAll(message: string): Promise<void>;
}

/** A repo wired to a local bare remote, with fixture-local git identity. */
async function gitFixture(t: TestContext): Promise<GitFixture> {
  const base = await tempDir("counterstep-git-", t);
  const repo = path.join(base, "repo");
  const origin = path.join(base, "origin.git");
  await execa("git", ["init", "--bare", "-b", "main", origin]);
  await execa("git", ["init", "-b", "main", repo]);
  await execa("git", ["config", "user.email", "fixture@example.com"], { cwd: repo });
  await execa("git", ["config", "user.name", "fixture"], { cwd: repo });
  await execa("git", ["remote", "add", "origin", origin], { cwd: repo });
  return {
    repo,
    origin,
    remoteSha: async () => {
      const { stdout } = await execa("git", ["ls-remote", "origin", "refs/heads/main"], { cwd: repo });
      return stdout.split("\t")[0]?.trim() ?? "";
    },
    commitAll: async (message) => {
      await execa("git", ["add", "-A"], { cwd: repo });
      await execa("git", ["commit", "-m", message], { cwd: repo });
    },
  };
}

function artifactFor(
  id: string,
  forwardCall: { tool: string; args: Record<string, unknown> },
  inverseOp: unknown,
  before: string,
) {
  return {
    id,
    forward_call: forwardCall,
    inverse_op: inverseOp,
    fingerprint: { scope: "test-scope", before },
    rehearsal: { surface: "shadow" as const, after: "", passed: false },
    status: "armed" as const,
  };
}

describe("fingerprint oracle", () => {
  test("is deterministic for identical state", async (t) => {
    const root = await tempDir("counterstep-fp-", t);
    await writeTree(root, { "a.txt": "hello" });

    const first = await fingerprintPaths(root, ["a.txt"]);
    const second = await fingerprintPaths(root, ["a.txt"]);

    assert.match(first, SHA256_HEX);
    assert.equal(first, second);
  });

  test("changes when file content changes", async (t) => {
    const root = await tempDir("counterstep-fp-", t);
    await writeTree(root, { "a.txt": "hello" });
    const before = await fingerprintPaths(root, ["a.txt"]);

    await writeFile(path.join(root, "a.txt"), "changed");

    assert.notEqual(await fingerprintPaths(root, ["a.txt"]), before);
  });

  test("fingerprints directory scopes recursively", async (t) => {
    const root = await tempDir("counterstep-fp-dir-", t);
    await writeTree(root, { "d/f.txt": "one", "d/g.txt": "two" });
    const baseline = await fingerprintPaths(root, ["d"]);

    await writeFile(path.join(root, "d/f.txt"), "one changed");
    assert.notEqual(await fingerprintPaths(root, ["d"]), baseline);

    // restore f.txt and add a new file instead: additions inside the scope
    // must be detectable, otherwise post-fire drift cannot be caught
    await writeTree(root, { "d/f.txt": "one", "d/h.txt": "new" });
    assert.notEqual(await fingerprintPaths(root, ["d"]), baseline);
  });
});

describe("remote-ref fingerprint", () => {
  test("tracks the remote ref target through force-push and restore", async (t) => {
    const fx = await gitFixture(t);
    await writeTree(fx.repo, { "a.txt": "seed" });
    await fx.commitAll("seed");
    await execa("git", ["push", "-u", "origin", "main"], { cwd: fx.repo });
    const shaA = await fx.remoteSha();

    const before = await fingerprintRemoteRef(fx.repo, "origin", "refs/heads/main");
    assert.match(before, SHA256_HEX);

    await writeTree(fx.repo, { "a.txt": "rewritten" });
    await fx.commitAll("rewrite");
    await execa("git", ["push", "--force", "origin", "main"], { cwd: fx.repo });
    assert.notEqual(await fingerprintRemoteRef(fx.repo, "origin", "refs/heads/main"), before);

    await execa("git", ["push", "--force", "origin", `${shaA}:refs/heads/main`], { cwd: fx.repo });
    assert.equal(await fingerprintRemoteRef(fx.repo, "origin", "refs/heads/main"), before);
  });
});

describe("inverse construction", () => {
  test("scopes rm -rf of a directory to that directory", async (t) => {
    const root = await tempDir("counterstep-inv-", t);
    await writeTree(root, { "src/legacy/a.txt": "a" });

    const plan = await constructInverse(
      { tool: "Bash", args: { command: "rm -rf src/legacy" } },
      { root },
    );
    if (!("inverse_op" in plan)) {
      assert.fail(`expected an inverse, got blocked: ${JSON.stringify(plan)}`);
    }
    assert.equal(plan.inverse_op.kind, "fs_restore");
    // a directory delete arms a directory-scoped restore so unexpected
    // content inside the scope stays detectable as post-fire drift
    assert.ok(
      plan.inverse_op.paths.includes("src/legacy"),
      `paths ${JSON.stringify(plan.inverse_op.paths)} must include src/legacy`,
    );
  });

  test("overwriting an existing file arms a restore of that file", async (t) => {
    const root = await tempDir("counterstep-inv-", t);
    await writeTree(root, { "notes.md": "v1" });

    const plan = await constructInverse(
      { tool: "Write", args: { file_path: "notes.md", content: "v2" } },
      { root },
    );
    if (!("inverse_op" in plan)) {
      assert.fail(`expected an inverse, got blocked: ${JSON.stringify(plan)}`);
    }
    assert.equal(plan.inverse_op.kind, "fs_restore");
    assert.ok(covers(plan.inverse_op.paths, "notes.md"));
  });

  test("moving a file arms a restore of its source path", async (t) => {
    const root = await tempDir("counterstep-inv-", t);
    await writeTree(root, { "old.txt": "data" });

    const plan = await constructInverse(
      { tool: "Bash", args: { command: "mv old.txt new.txt" } },
      { root },
    );
    if (!("inverse_op" in plan)) {
      assert.fail(`expected an inverse, got blocked: ${JSON.stringify(plan)}`);
    }
    assert.equal(plan.inverse_op.kind, "fs_restore");
    assert.ok(covers(plan.inverse_op.paths, "old.txt"));
  });

  test("a force push arms a remote-ref restore inverse", async (t) => {
    const fx = await gitFixture(t);
    await writeTree(fx.repo, { "a.txt": "seed" });
    await fx.commitAll("seed");
    await execa("git", ["push", "-u", "origin", "main"], { cwd: fx.repo });
    const shaA = await fx.remoteSha();

    const plan = await constructInverse(
      { tool: "Bash", args: { command: "git push --force origin main" } },
      { root: fx.repo },
    );
    if (!("inverse_op" in plan)) {
      assert.fail(`expected an inverse, got blocked: ${JSON.stringify(plan)}`);
    }
    assert.equal(plan.inverse_op.kind, "git_push_ref");
    assert.equal(plan.inverse_op.remote, "origin");
    assert.match(plan.inverse_op.ref, /^(refs\/heads\/)?main$/);
    assert.equal(plan.inverse_op.to_sha, shaA);
  });

  test("third-party HTTP writes stay blocked with a stated reason", async (t) => {
    const root = await tempDir("counterstep-inv-", t);

    const plan = await constructInverse(
      {
        tool: "Bash",
        args: { command: "curl -X POST -d @payload.json https://api.example.com/v1/items" },
      },
      { root },
    );
    if (!("blocked" in plan)) {
      assert.fail("expected a blocked result for a non-invertible op");
    }
    assert.equal(typeof plan.blocked, "string");
    assert.ok(plan.blocked.length > 0, "the block reason must be stated");
  });
});

describe("shadow rehearsal", () => {
  test("a correct fs inverse rehearses green on the shadow copy", async (t) => {
    const root = await tempDir("counterstep-reh-", t);
    await writeTree(root, { "src/legacy/a.txt": "alpha", "src/legacy/b.txt": "beta" });
    const before = await fingerprintPaths(root, ["src/legacy"]);

    const plan = await constructInverse(
      { tool: "Bash", args: { command: "rm -rf src/legacy" } },
      { root },
    );
    if (!("inverse_op" in plan)) assert.fail("expected an inverse");

    const result = await rehearse(
      artifactFor(
        "01FSREHEARSEPASS0000000000",
        { tool: "Bash", args: { command: "rm -rf src/legacy" } },
        plan.inverse_op,
        before,
      ),
      { root },
    );

    assert.equal(result.surface, "shadow");
    assert.equal(result.passed, true);
    assert.equal(result.after, before);
  });

  test("a wrong inverse fails the rehearsal oracle", async (t) => {
    const root = await tempDir("counterstep-reh-", t);
    await writeTree(root, { "src/legacy/a.txt": "alpha" });
    const before = await fingerprintPaths(root, ["src/legacy"]);

    const result = await rehearse(
      artifactFor(
        "01FSREHEARSEFAIL0000000000",
        { tool: "Bash", args: { command: "rm -rf src/legacy" } },
        { kind: "fs_restore", paths: ["definitely/not/snapshotted"] },
        before,
      ),
      { root },
    );

    assert.equal(result.passed, false);
    assert.notEqual(result.after, before);
  });

  test("a force-push inverse rehearses against a bare shadow clone", async (t) => {
    const fx = await gitFixture(t);
    await writeTree(fx.repo, { "a.txt": "seed" });
    await fx.commitAll("seed");
    await execa("git", ["push", "-u", "origin", "main"], { cwd: fx.repo });
    const shaA = await fx.remoteSha();

    // destructive local commit, not yet pushed
    await rm(path.join(fx.repo, "a.txt"));
    await fx.commitAll("delete a.txt");

    const before = await fingerprintRemoteRef(fx.repo, "origin", "refs/heads/main");
    const plan = await constructInverse(
      { tool: "Bash", args: { command: "git push --force origin main" } },
      { root: fx.repo },
    );
    if (!("inverse_op" in plan)) assert.fail("expected an inverse");

    const result = await rehearse(
      artifactFor(
        "01GITREHEARSEPASS000000000",
        { tool: "Bash", args: { command: "git push --force origin main" } },
        plan.inverse_op,
        before,
      ),
      { root: fx.repo },
    );

    assert.equal(result.passed, true);
    assert.equal(result.after, before);
    // rehearsal must replay against the shadow clone only
    assert.equal(await fx.remoteSha(), shaA, "the real remote must stay untouched");
  });

  test("an inverse pointing at an unknown sha fails rehearsal", async (t) => {
    const fx = await gitFixture(t);
    await writeTree(fx.repo, { "a.txt": "seed" });
    await fx.commitAll("seed");
    await execa("git", ["push", "-u", "origin", "main"], { cwd: fx.repo });

    const before = await fingerprintRemoteRef(fx.repo, "origin", "refs/heads/main");
    const result = await rehearse(
      artifactFor(
        "01GITREHEARSEFAIL000000000",
        { tool: "Bash", args: { command: "git push --force origin main" } },
        { kind: "git_push_ref", remote: "origin", ref: "refs/heads/main", to_sha: "f".repeat(40) },
        before,
      ),
      { root: fx.repo },
    );

    assert.equal(result.passed, false);
  });
});

describe("ledger", () => {
  test("appends artifacts to an append-only JSONL ledger", async (t) => {
    const root = await tempDir("counterstep-ledger-", t);
    const one = artifactFor("01LEDGERONE00000000000000000", { tool: "Bash", args: { command: "rm -rf one" } }, { kind: "fs_restore", paths: ["one"] }, "a".repeat(64));
    const two = artifactFor("01LEDGERTWO00000000000000000", { tool: "Bash", args: { command: "rm -rf two" } }, { kind: "fs_restore", paths: ["two"] }, "b".repeat(64));

    await appendArtifact(root, one);
    await appendArtifact(root, two);

    assert.ok(existsSync(path.join(root, ".counterstep", "ledger.jsonl")));
    const listed = await listArtifacts(root);
    assert.equal(listed.length, 2);
    assert.deepEqual(new Set(listed.map((a) => a.id)), new Set([one.id, two.id]));
    assert.ok(listed.every((a) => a.status === "armed"));
  });

  test("fire restores the pre-action content and marks the artifact fired", async (t) => {
    const root = await tempDir("counterstep-fire-", t);
    await writeTree(root, { "notes.md": "v1" });

    const decision = await handleHookEvent(
      { tool: "Write", args: { file_path: "notes.md", content: "v2" } },
      { root },
    );
    assert.equal(decision.decision, "allow");
    await writeFile(path.join(root, "notes.md"), "v2");

    const armed = await listArtifacts(root);
    assert.equal(armed.length, 1);
    assert.ok(armed[0]);
    assert.equal(armed[0].status, "armed");

    const result = await fireArtifact(root, { id: armed[0].id });
    assert.equal(result.status, "fired");
    assert.equal(await readFile(path.join(root, "notes.md"), "utf8"), "v1");

    const fired = await getArtifact(root, armed[0].id);
    assert.ok(fired);
    assert.equal(fired.status, "fired");
  });

  test("fire --last fires the most recently armed artifact", async (t) => {
    const root = await tempDir("counterstep-last-", t);
    await writeTree(root, { "k.txt": "k1", "j.txt": "j1" });

    await handleHookEvent({ tool: "Write", args: { file_path: "k.txt", content: "k2" } }, { root });
    await handleHookEvent({ tool: "Write", args: { file_path: "j.txt", content: "j2" } }, { root });
    await writeFile(path.join(root, "k.txt"), "k2");
    await writeFile(path.join(root, "j.txt"), "j2");

    const result = await fireArtifact(root, { last: true });

    const listed = await listArtifacts(root);
    assert.equal(listed.length, 2);
    const jArtifact = listed.find((a) => JSON.stringify(a.forward_call.args).includes("j.txt"));
    const kArtifact = listed.find((a) => JSON.stringify(a.forward_call.args).includes("k.txt"));
    assert.ok(jArtifact);
    assert.ok(kArtifact);
    assert.equal(result.id, jArtifact.id, "the most recently armed artifact must fire");

    assert.equal(await readFile(path.join(root, "j.txt"), "utf8"), "j1");
    assert.equal(await readFile(path.join(root, "k.txt"), "utf8"), "k2");
    assert.equal(jArtifact.status, "fired");
    assert.equal(kArtifact.status, "armed");
  });

  test("firing surfaces drift as stale instead of fired", async (t) => {
    const root = await tempDir("counterstep-stale-", t);
    await writeTree(root, { "src/legacy/a.txt": "A", "src/legacy/b.txt": "B" });

    const decision = await handleHookEvent(
      { tool: "Bash", args: { command: "rm -rf src/legacy" } },
      { root },
    );
    assert.equal(decision.decision, "allow");
    await rm(path.join(root, "src/legacy"), { recursive: true });
    // drift: content appears inside the armed scope after the forward action ran
    await writeTree(root, { "src/legacy/stray.txt": "S" });

    const result = await fireArtifact(root, { last: true });
    assert.equal(result.status, "stale");

    const listed = await listArtifacts(root);
    const artifact = listed.find((a) => a.id === result.id);
    assert.ok(artifact);
    assert.equal(artifact.status, "stale");

    // the snapshot content came back; the drifted file was not silently clobbered
    assert.equal(await readFile(path.join(root, "src/legacy/a.txt"), "utf8"), "A");
    assert.equal(await readFile(path.join(root, "src/legacy/stray.txt"), "utf8"), "S");
  });
});
