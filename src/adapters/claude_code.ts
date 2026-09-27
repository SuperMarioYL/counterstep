/**
 * Claude Code adapter — the only module that knows Claude Code's shapes.
 *
 * Three responsibilities (plan §4):
 *   - translate PreToolUse hook payloads (stdin JSON) into forward calls;
 *   - render hook decisions in the hookSpecificOutput schema Claude Code reads;
 *   - own the .claude/settings.json wiring that `counterstep init` installs.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { HookDecision, HookEvent } from "../hook.js";

/**
 * Parse one PreToolUse payload into the forward call the pipeline classifies
 * and (when destructive) arms an inverse for. A payload without a tool name or
 * input still yields a well-formed call; the classifier treats it as safe.
 */
export function parsePreToolUse(payload: { tool_name?: string; tool_input?: unknown }): HookEvent {
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const args =
    payload.tool_input !== null && typeof payload.tool_input === "object"
      ? (payload.tool_input as Record<string, unknown>)
      : {};
  return { tool, args };
}

export interface RenderedDecision {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason?: string;
  };
}

/**
 * Render a decision as the PreToolUse hook output Claude Code expects: the
 * permission decision rides in hookSpecificOutput, and the reason travels with
 * it so the agent (and the developer) can see why a call stayed blocked.
 */
export function renderDecision(decision: HookDecision): RenderedDecision {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.decision,
      ...(decision.reason !== undefined ? { permissionDecisionReason: decision.reason } : {}),
    },
  };
}

/** The hook entry `counterstep init` manages in .claude/settings.json. */
export function claudeCodeHookEntry(): Record<string, unknown> {
  return {
    matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit",
    hooks: [{ type: "command", command: "counterstep hook" }],
  };
}

/**
 * Wire the PreToolUse hook into <repoRoot>/.claude/settings.json. Existing
 * settings are merged, never clobbered, and the counterstep entry is
 * idempotent: re-running init never adds a second one.
 */
export async function wireClaudeCodeHook(repoRoot: string): Promise<void> {
  const settingsDir = path.join(repoRoot, ".claude");
  const settingsPath = path.join(settingsDir, "settings.json");

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
      if (parsed !== null && typeof parsed === "object") {
        settings = parsed as Record<string, unknown>;
      }
    } catch {
      throw new Error(
        "counterstep init: .claude/settings.json is not valid JSON; fix or remove it and re-run init",
      );
    }
  }

  const hooks =
    settings.hooks !== null && typeof settings.hooks === "object"
      ? ({ ...(settings.hooks as Record<string, unknown>) })
      : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse] : [];
  const alreadyWired = preToolUse.some((entry) => JSON.stringify(entry).includes("counterstep"));
  if (!alreadyWired) {
    preToolUse.push(claudeCodeHookEntry());
  }
  hooks.PreToolUse = preToolUse;
  settings.hooks = hooks;

  await mkdir(settingsDir, { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
