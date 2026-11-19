// Mutation-kill tests for the PostToolUse kill-proof nudge — 2026-11-05 dogfood campaign
// (docs/reviews/kill-proof-dogfood.md): which message a receipt's state produces, and that
// the new-case rule is applied against HEAD by default.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KillProofIndex, KillProofIndexRow } from "../kill-proof/receipt.js";
import type { Certification } from "../kill-proof/receipt-freshness.js";
import type { KillProofReceipt } from "../kill-proof/types.js";
import { killProofNudge } from "./post-tool-kill-proof.js";

const REL = "src/lib/clamp.mutation-kill.test.ts";
const OTHER = "src/lib/other.mutation-kill.test.ts";
const row = (verdict: KillProofIndexRow["verdict"], killedTests: string[] = [REL]): KillProofIndexRow => ({
	id: "0123456789abcdef", verdict, provedAt: "2026-11-04T23:00:00.000Z", mutant: "m", source: { path: "src/lib/clamp.ts", sha256: "s" }, tests: [{ path: REL, sha256: "t" }, { path: OTHER, sha256: "u" }], killedTests,
});
const index = (...receipts: KillProofIndexRow[]): KillProofIndex => ({ version: 1, receipts });
/** A receipt stub with the fields the nudge reads: verdict, killedTests and the recorded cases of REL (`underMutant.cases`). */
const receipt = (verdict: KillProofReceipt["verdict"], killedTests: string[], killedCases: string[] = []): KillProofReceipt =>
	({ id: "0123456789abcdef", verdict, killedTests, underMutant: { cases: killedCases.map(name => ({ test: `${REL} › ${name}`, verdict: "killed" })) } } as unknown as KillProofReceipt);

describe("killProofNudge — which message a receipt's state earns", () => {
	// test-contract: bug - a receipt that is STALE and also misses the new cases is reported as stale; "a fresh kill proof covers this file" must only be said when the only reason is the new cases
	it("a stale receipt with uncovered new cases is reported as stale, not as a fresh proof", () => {
		const certify = (): Certification => ({ certified: false, receipt: receipt("killed", [REL]), reasons: ["test src/lib/clamp.mutation-kill.test.ts changed since the proof", "newly added case(s) not among this receipt's killed cases: new case"], uncovered: ["new case"] });
		const text = killProofNudge({ root: "/repo", relPath: REL, newCases: ["new case"], readIndex: () => index(row("killed")), certify });
		expect(text).toContain("1 kill proof(s) went stale");
		expect(text).not.toContain("a fresh kill proof covers this file");
	});
	// test-contract: bug - a killed receipt that killed through ANOTHER named file is a run that did not kill through this one, never a stale proof for it
	it("a receipt that killed only through another named file is counted as not killing here", () => {
		const certify = (): Certification => ({ certified: false, receipt: receipt("killed", [OTHER]), reasons: [`receipt did not kill through ${REL}`] });
		const text = killProofNudge({ root: "/repo", relPath: REL, newCases: [], readIndex: () => index(row("killed", [OTHER])), certify });
		expect(text).toContain("1 recorded run(s) did not kill through this file");
		expect(text).not.toContain("went stale");
	});
});

describe("killProofNudge — new cases are computed against HEAD by default", () => {
	let root = "";
	afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
	// test-contract: invariant - without an explicit `newCases`, the titles added since HEAD are what the fresh receipts together must have killed (review L5: the nudge applies the Stop check's rule; round 6 finding 3: judged across receipts, each receipt asked only for its own freshness)
	it("a case added since HEAD is required of the certifying receipts", () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-nudge-mk-")));
		const git = (...args: string[]): void => { execFileSync("git", ["-C", root, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { stdio: "ignore" }); };
		git("init", "-q");
		mkdirSync(join(root, "src/lib"), { recursive: true });
		writeFileSync(join(root, REL), "it('old case', () => {});\n");
		git("add", ".");
		git("commit", "-qm", "init");
		writeFileSync(join(root, REL), "it('old case', () => {});\nit('new case', () => {});\n");
		const killedOnlyOld = vi.fn((): Certification => ({ certified: true, receipt: receipt("killed", [REL], ["old case"]) }));
		const text = killProofNudge({ root, relPath: REL, readIndex: () => index(row("killed")), certify: killedOnlyOld });
		expect(killedOnlyOld).toHaveBeenCalledWith(root, "0123456789abcdef", REL, undefined, expect.any(Map));
		expect(text).toContain("1 fresh kill proof(s) cover this file, but not the newly added case(s): new case");
		const killedNew = (): Certification => ({ certified: true, receipt: receipt("killed", [REL], ["old case", "new case"]) });
		expect(killProofNudge({ root, relPath: REL, readIndex: () => index(row("killed")), certify: killedNew })).toBeNull();
	});
});
