/**
 * End-to-end contract tests: the plan §3 minimum happy path.
 *
 *   counterstep init wires the Claude Code PreToolUse hook and creates
 *   .counterstep/ (ledger + shadow store); a destructive call is intercepted,
 *   fingerprinted, its inverse shadow-rehearsed and released as "armed"; the
 *   developer fires the armed inverse one-key afterwards and the affected
 *   state is restored byte-identically (m1 file wipe, m2 force push).
 *
 * Also pinned here:
 *   - non-destructive calls pass through without arming anything;
 *   - non-invertible destructive calls are denied with the reason stated;
 *   - an expired rehearsal budget denies fail-closed (never a silent release);
 *   - the Claude Code adapter translates PreToolUse payloads and decisions.
 */
import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";

import { initCounterstep } from "../src/cli";
import { handleHookEvent } from "../src/hook";
import { fingerprintPaths } from "../src/fingerprint";
import { fireArtifact, listArtifacts } from "../src/ledger";
import { parsePreToolUse, renderDecision } from "../src/adapters/claude_code";

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

/** A plain git repo with a baseline commit under src/legacy. */
async function gitRepo(t: TestContext): Promise<string> {
  const repo = await tempDir("counterstep-e2e-", t);
  await execa("git", ["init", "-b", "main", repo]);
  await execa("git", ["config", "user.email", "fixture@example.com"], { cwd: repo });
  await execa("git", ["config", "user.name", "fixture"], { cwd: repo });
  await writeTree(repo, { "src/legacy/a.txt": "legacy-a", "src/legacy/b.txt": "legacy-b" });
  await execa("git", ["add", "-A"], { cwd: repo });
  await execa("git", ["commit", "-m", "baseline"], { cwd: repo });
  return repo;
}

async function remoteSha(repo: string): Promise<string> {
  const { stdout } = await execa("git", ["ls-remote", "origin", "refs/heads/main"], { cwd: repo });
  return stdout.split("\t")[0]?.trim() ?? "";
}

describe("Claude Code adapter", () => {
  test("parses PreToolUse payloads into forward calls", () => {
    const call = parsePreToolUse({ tool_name: "Bash", tool_input: { command: "rm -rf src/legacy" } });
    assert.equal(call.tool, "Bash");
    assert.deepEqual(call.args, { command: "rm -rf src/legacy" });
  });

  test("renders decisions as Claude Code hook output", () => {
    const deny = renderDecision({ decision: "deny", reason: "blocked until armed" }) as any;
    assert.equal(deny.hookSpecificOutput?.hookEventName, "PreToolUse");
    assert.equal(deny.hookSpecificOutput?.permissionDecision, "deny");
    assert.equal(deny.hookSpecificOutput?.permissionDecisionReason, "blocked until armed");

    const allow = renderDecision({ decision: "allow" }) as any;
    assert.equal(allow.hookSpecificOutput?.permissionDecision, "allow");
  });
});

describe("counterstep init", () => {
  test("wires the PreToolUse hook and creates the state directory", async (t) => {
    const repo = await gitRepo(t);

    await initCounterstep(repo);

    const settings = JSON.parse(await readFile(path.join(repo, ".claude", "settings.json"), "utf8"));
    const hookEntries = settings?.hooks?.PreToolUse;
    assert.ok(Array.isArray(hookEntries) && hookEntries.length >= 1);
    assert.ok(JSON.stringify(hookEntries).includes("counterstep"));
    assert.ok(existsSync(path.join(repo, ".counterstep")));
    assert.ok(existsSync(path.join(repo, ".counterstep", "shadow")));
  });

  test("merges into existing settings without clobbering them", async (t) => {
    const repo = await gitRepo(t);
    await mkdir(path.join(repo, ".claude"), { recursive: true });
    await writeFile(path.join(repo, ".claude", "settings.json"), JSON.stringify({ model: "opus" }));

    await initCounterstep(repo);

    const settings = JSON.parse(await readFile(path.join(repo, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.model, "opus");
    assert.ok(JSON.stringify(settings.hooks?.PreToolUse).includes("counterstep"));
  });

  test("is idempotent", async (t) => {
    const repo = await gitRepo(t);

    await initCounterstep(repo);
    await initCounterstep(repo);

    const settings = JSON.parse(await readFile(path.join(repo, ".claude", "settings.json"), "utf8"));
    const counterstepEntries = settings.hooks.PreToolUse.filter((entry: unknown) =>
      JSON.stringify(entry).includes("counterstep"),
    );
    assert.equal(counterstepEntries.length, 1);
  });
});

describe("pass-through and fail-closed behaviour", () => {
  test("non-destructive calls pass through without arming anything", async (t) => {
    const repo = await gitRepo(t);
    await initCounterstep(repo);

    const ls = await handleHookEvent({ tool: "Bash", args: { command: "ls -la" } }, { root: repo });
    assert.equal(ls.decision, "allow");

    const newFile = await handleHookEvent(
      { tool: "Write", args: { file_path: "fresh.txt", content: "new" } },
      { root: repo },
    );
    assert.equal(newFile.decision, "allow");

    assert.equal((await listArtifacts(repo)).length, 0);
  });

  test("non-invertible destructive calls are denied with the reason stated", async (t) => {
    const repo = await gitRepo(t);
    await initCounterstep(repo);

    const decision = await handleHookEvent(
      {
        tool: "Bash",
        args: { command: "curl -X POST -d @payload.json https://api.example.com/v1/items" },
      },
      { root: repo },
    );

    assert.equal(decision.decision, "deny");
    assert.ok((decision.reason ?? "").length > 0);
    assert.equal((await listArtifacts(repo)).length, 0);
  });

  test("an expired rehearsal budget denies fail-closed and asks for a re-run", async (t) => {
    const repo = await gitRepo(t);
    await initCounterstep(repo);

    const decision = await handleHookEvent(
      { tool: "Bash", args: { command: "rm -rf src/legacy" } },
      { root: repo, budgetMs: 0 },
    );

    assert.equal(decision.decision, "deny");
    assert.match(decision.reason ?? "", /re-?run|retry/i);
    assert.equal((await listArtifacts(repo)).length, 0);
  });
});

describe("file wipe happy path (m1)", () => {
  test("a destructive rm is released as armed and fire --last restores it byte-identical", async (t) => {
    const repo = await gitRepo(t);
    await initCounterstep(repo);
    const before = await fingerprintPaths(repo, ["src/legacy"]);

    const decision = await handleHookEvent(
      { tool: "Bash", args: { command: "rm -rf src/legacy" } },
      { root: repo },
    );
    assert.equal(decision.decision, "allow");

    const armed = await listArtifacts(repo);
    assert.equal(armed.length, 1);
    const artifact = armed[0]!;
    assert.equal(artifact.status, "armed");
    assert.equal(artifact.rehearsal.passed, true);
    assert.equal(artifact.forward_call.tool, "Bash");
    assert.match(artifact.fingerprint.before, SHA256_HEX);
    assert.equal(artifact.fingerprint.before, before);

    // the forward call executes
    await rm(path.join(repo, "src/legacy"), { recursive: true });
    assert.ok(!existsSync(path.join(repo, "src/legacy")));

    const result = await fireArtifact(repo, { last: true });
    assert.equal(result.status, "fired");
    assert.equal(await readFile(path.join(repo, "src/legacy", "a.txt"), "utf8"), "legacy-a");
    assert.equal(await readFile(path.join(repo, "src/legacy", "b.txt"), "utf8"), "legacy-b");
    assert.equal(await fingerprintPaths(repo, ["src/legacy"]), before);
  });
});

describe("force-push reversal (m2)", () => {
  test("fire --last restores the remote ref to the prior commit", async (t) => {
    const base = await tempDir("counterstep-e2e-push-", t);
    const repo = path.join(base, "repo");
    const origin = path.join(base, "origin.git");
    await execa("git", ["init", "--bare", "-b", "main", origin]);
    await execa("git", ["init", "-b", "main", repo]);
    await execa("git", ["config", "user.email", "fixture@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "fixture"], { cwd: repo });
    await execa("git", ["remote", "add", "origin", origin], { cwd: repo });

    await writeTree(repo, { "a.txt": "seed" });
    await execa("git", ["add", "-A"], { cwd: repo });
    await execa("git", ["commit", "-m", "seed"], { cwd: repo });
    await execa("git", ["push", "-u", "origin", "main"], { cwd: repo });
    const shaA = await remoteSha(repo);

    // destructive local commit; the agent then attempts the force push
    await rm(path.join(repo, "a.txt"));
    await execa("git", ["add", "-A"], { cwd: repo });
    await execa("git", ["commit", "-m", "delete everything"], { cwd: repo });
    const shaB = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: repo })
    ).stdout.trim();

    const decision = await handleHookEvent(
      { tool: "Bash", args: { command: "git push --force origin main" } },
      { root: repo },
    );
    assert.equal(decision.decision, "allow");

    const armed = await listArtifacts(repo);
    assert.equal(armed.length, 1);
    const artifact = armed[0]!;
    assert.equal(artifact.inverse_op.kind, "git_push_ref");
    if (artifact.inverse_op.kind === "git_push_ref") {
      assert.equal(artifact.inverse_op.remote, "origin");
      assert.match(artifact.inverse_op.ref, /^(refs\/heads\/)?main$/);
      assert.equal(artifact.inverse_op.to_sha, shaA);
    }
    assert.equal(artifact.rehearsal.passed, true);

    // the forward call executes against the real remote
    await execa("git", ["push", "--force", "origin", "main"], { cwd: repo });
    assert.equal(await remoteSha(repo), shaB);

    const result = await fireArtifact(repo, { last: true });
    assert.equal(result.status, "fired");
    assert.equal(await remoteSha(repo), shaA);
  });
});
