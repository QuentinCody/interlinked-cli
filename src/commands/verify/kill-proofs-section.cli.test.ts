// Built-CLI smoke for the `interlinked verify` kill_proofs section: the BUILT candidate
// (`dist/index.js`, same stance as project-e2e/dogfood.test.ts) judges a throwaway
// repository's receipts. A fresh receipt ⇒ key present, no issue, exit 0; a stale KILLED
// receipt ⇒ one `kill_proof_stale` detail and exit 1; no receipt ⇒ no `kill_proofs` key.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnvironment, hashFile, receiptId, sealReceipt, writeKillProof } from "../../harness/kill-proof/receipt.js";
import { lineTextAt, resolveMutant } from "../../harness/kill-proof/resolve.js";
import type { HashedFile, KillProofReceipt } from "../../harness/kill-proof/types.js";

const CANDIDATE = resolve("dist/index.js");
const TIMEOUT = 180_000;
const SOURCE = "export function clamp(n: number, max: number): number {\n\treturn n > max ? max : n;\n}\n";
const TEST = "import { clamp } from './clamp.js';\nit('caps', () => { expect(clamp(5, 3)).toBe(3); });\n";

let root: string;
function write(path: string, text: string): void {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), text);
}
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "verify-kill-proofs-cli-")));
	execFileSync("git", ["-C", root, "init", "-q"]);
	write("src/clamp.ts", SOURCE);
	write("src/clamp.test.ts", TEST);
	execFileSync("git", ["-C", root, "add", "."]);
	execFileSync("git", ["-C", root, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "fixture"]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function recordKill(provedAt = "2026-11-05T00:00:00.000Z"): KillProofReceipt {
	const resolved = resolveMutant(root, { kind: "explicit", file: "src/clamp.ts", find: "n > max", replace: "n >= max" });
	if (!resolved.ok) throw new Error(resolved.reason);
	const mutant = { ...resolved.mutant, lineText: lineTextAt(readFileSync(join(root, "src/clamp.ts"), "utf8"), resolved.mutant.offset) };
	const source = hashFile(root, "src/clamp.ts") as HashedFile, tests = [hashFile(root, "src/clamp.test.ts") as HashedFile];
	const environment = captureEnvironment(root);
	const receipt = sealReceipt({
		version: 1, id: receiptId({ source, mutant, tests, boundImports: [], environment }), digest: "", verdict: "killed", reasons: [], provedAt, root,
		source, mutant, tests, boundImports: [], killedTests: ["src/clamp.test.ts"],
		baseline: { cases: 1, durationMs: 5 }, underMutant: { durationMs: 5, timedOut: false, cases: [{ test: "src/clamp.test.ts › caps", verdict: "killed" }] }, environment,
	});
	writeKillProof(root, receipt);
	return receipt;
}
function verifyJson(): { status: number | null; json: Record<string, unknown>; stderr: string } {
	const run = spawnSync(process.execPath, [CANDIDATE, "verify", "--json"], { cwd: root, encoding: "utf8", timeout: TIMEOUT, env: { ...process.env, NO_COLOR: "1" } });
	return { status: run.status, json: JSON.parse(run.stdout) as Record<string, unknown>, stderr: run.stderr };
}

describe("built CLI: verify --json kill_proofs — positive (a finding)", () => {
	it("P1: a stale KILLED receipt is one kill_proof_stale detail with the renew command, and verify exits 1", () => {
		const receipt = recordKill();
		write("src/clamp.ts", `${SOURCE}// later\n`);
		const { status, json } = verifyJson();
		expect(status).toBe(1);
		expect(json.kill_proofs).toMatchObject({
			issues: 1, files: ["src/clamp.test.ts"], skipped: false,
			details: [{ check: "kill_proof_stale", id: receipt.id, freshness: "stale", reasons: ["source src/clamp.ts changed since the proof"], fix: "interlinked tests prove-kill --mutant <id> --test src/clamp.test.ts" }],
		});
	}, TIMEOUT);
});

describe("built CLI: verify --json kill_proofs — negative (no finding)", () => {
	it("N1: a fresh committed receipt is listed under `kill_proofs` with no issue, and verify exits 0", () => {
		const receipt = recordKill();
		const { status, json, stderr } = verifyJson();
		expect(status, stderr).toBe(0);
		expect(json.kill_proofs).toMatchObject({ issues: 0, files: [], details: [], receipts: [{ id: receipt.id, verdict: "killed", freshness: "fresh", tests: ["src/clamp.test.ts"] }] });
	}, TIMEOUT);
	it("N3: after a re-proof, the superseded stale receipt is no finding and verify exits 0; the tally says `1 superseded` (verification af8b93d3 §6)", () => {
		const older = recordKill();
		write("src/clamp.ts", `${SOURCE}// later\n`);
		execFileSync("git", ["-C", root, "add", "."]);
		execFileSync("git", ["-C", root, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "edit"]);
		const newer = recordKill("2026-11-06T00:00:00.000Z");
		const { status, json, stderr } = verifyJson();
		expect(status, stderr).toBe(0);
		expect(json.kill_proofs).toMatchObject({ issues: 0, files: [], details: [] });
		const receipts = (json.kill_proofs as { receipts: Array<{ id: string; freshness: string; supersededBy?: string }> }).receipts;
		expect(receipts).toEqual(expect.arrayContaining([expect.objectContaining({ id: older.id, freshness: "stale", supersededBy: newer.id }), expect.objectContaining({ id: newer.id, freshness: "fresh" })]));
		const list = spawnSync(process.execPath, [CANDIDATE, "tests", "kill-proofs", "--verify"], { cwd: root, encoding: "utf8", timeout: TIMEOUT, env: { ...process.env, NO_COLOR: "1" } });
		expect(list.status, list.stderr).toBe(0);
		expect(list.stdout).toContain("2 KILLED proof(s): 1 fresh, 0 uncommitted, 0 stale, 1 superseded.");
	}, TIMEOUT);
	it("N2: a repository without receipts has no `kill_proofs` key at all", () => {
		const { status, json, stderr } = verifyJson();
		expect(status, stderr).toBe(0);
		expect("kill_proofs" in json).toBe(false);
		expect(json.project_e2e).toMatchObject({ status: "unconfigured" });
	}, TIMEOUT);
});
