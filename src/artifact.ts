/**
 * The Compensation Artifact — the core primitive (plan §2).
 *
 * Three invariants separate this from a backup script:
 *   1. a forward call in the destructive class stays blocked until an artifact
 *      with `rehearsal.passed === true` exists in the ledger;
 *   2. the rehearsal oracle is machine-checkable (src/rehearse.ts);
 *   3. firing is human-initiated and re-verifies the fingerprint, marking the
 *      artifact `stale` when live state drifted.
 */
import { randomBytes } from "node:crypto";

export type InverseOp =
  | { kind: "fs_restore"; paths: string[] }
  | { kind: "git_push_ref"; remote: string; ref: string; to_sha: string };

export type ArtifactStatus = "armed" | "fired" | "failed" | "stale";

export interface CompensationArtifact {
  id: string; // ULID
  forward_call: { tool: string; args: object }; // intercepted destructive call
  inverse_op: InverseOp;
  fingerprint: { scope: string; before: string }; // sha256 over pre-action state
  rehearsal: { surface: "shadow"; after: string; passed: boolean };
  status: ArtifactStatus;
}

// Crockford base32 — the ULID alphabet (no I, L, O, U)
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * ULID: 48-bit millisecond timestamp + 80 bits of randomness. Sortable by
 * creation time, which is what `counterstep fire --last` relies on.
 */
export function newArtifactId(now: number = Date.now()): string {
  let ts = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = (ENCODING[ts % 32] ?? "0") + time;
    ts = Math.floor(ts / 32);
  }
  let randomness = BigInt(`0x${randomBytes(10).toString("hex")}`);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand = (ENCODING[Number(randomness & 31n)] ?? "0") + rand;
    randomness >>= 5n;
  }
  return time + rand;
}
