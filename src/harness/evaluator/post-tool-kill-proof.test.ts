import { describe, expect, it } from "vitest";
import type { Certification, KillProofIndex, KillProofIndexRow } from "../kill-proof/receipt.js";
import type { KillProofReceipt } from "../kill-proof/types.js";
import type { HarnessEvent } from "../types.js";
import { collectKillProofWriteWarning, killProofNudge } from "./post-tool-kill-proof.js";

const REL = "src/lib/clamp.mutation-kill.test.ts";
const row = (verdict: KillProofIndexRow["verdict"], id = "0123456789abcdef", killedTests = verdict === "killed" ? [REL] : []): KillProofIndexRow => ({
	id, verdict, provedAt: "2026-11-04T23:00:00.000Z", mutant: "m", source: { path: "src/lib/clamp.ts", sha256: "s" }, tests: [{ path: REL, sha256: "t" }], killedTests,
});
const index = (...receipts: KillProofIndexRow[]): KillProofIndex => ({ version: 1, receipts });
/** A receipt file stub carrying only the fields the nudge reads. */
const receipt = (verdict: KillProofReceipt["verdict"], killedTests: string[] = verdict === "killed" ? [REL] : []): KillProofReceipt =>
	({ verdict, killedTests } as unknown as KillProofReceipt);
const certified = (): Certification => ({ certified: true, receipt: receipt("killed") });
const stale = (reasons = ["test changed"]): Certification => ({ certified: false, receipt: receipt("killed"), reasons });
const survived = (): Certification => ({ certified: false, receipt: receipt("survived"), reasons: [`receipt did not kill through ${REL}`] });
const missing = (): Certification => ({ certified: false, receipt: null, reasons: ["receipt file missing or unreadable"] });
const event = (file_path: string, tool_name = "Write"): HarnessEvent => ({ hook_event: "PostToolUse", session_id: "s", agent_source: "claude", tool_name, tool_input: { file_path }, timestamp: "2026-11-04T23:00:00.000Z", cwd: "/repo" }) as unknown as HarnessEvent;

describe("killProofNudge — positive (must fire)", () => {
	it("P1: no receipt at all names the prove-kill command and says what is not proof", () => {
		const text = killProofNudge({ root: "/repo", relPath: REL, readIndex: () => index(), certify: certified });
		expect(text).toContain("[interlinked:kill-proof]");
		expect(text).toContain(`interlinked tests prove-kill --mutant <id> --test ${REL}`);
		expect(text).toContain("not proof");
	});
	it("P2: a killed receipt whose bytes or runtime changed is reported as stale, with the re-run command", () => {
		const text = killProofNudge({ root: "/repo", relPath: REL, readIndex: () => index(row("killed")), certify: () => stale() });
		expect(text).toContain("1 kill proof(s) went stale");
		expect(text).toContain("Re-run:");
	});
	it("P3: survived receipts count as runs that did not kill through this file, without echoing a verdict word (review K10)", () => {
		const text = killProofNudge({ root: "/repo", relPath: REL, readIndex: () => index(row("survived", "aaaaaaaaaaaaaaaa"), row("survived", "bbbbbbbbbbbbbbbb")), certify: survived });
		expect(text).toContain("2 recorded run(s) did not kill through this file");
		expect(text).not.toContain("(killed)");
	});
	it("P4: a forged index row (verdict killed) over a receipt that did not kill is ignored — the receipt file decides (review K2)", () => {
		expect(killProofNudge({ root: "/repo", relPath: REL, readIndex: () => index(row("killed")), certify: survived })).toContain("no executed kill proof covers");
	});
	it("P5: an index row whose receipt file is unreadable is nothing (review R8)", () => {
		expect(killProofNudge({ root: "/repo", relPath: REL, readIndex: () => index(row("killed")), certify: missing })).toContain("no executed kill proof covers");
	});
});

describe("killProofNudge — negative (must not fire)", () => {
	it("N1: a receipt that certifies this file now silences the nudge", () => {
		expect(killProofNudge({ root: "/repo", relPath: REL, readIndex: () => index(row("killed")), certify: certified })).toBeNull();
	});
	it("N2: a certified receipt for ANOTHER test file does not count", () => {
		const other = { ...row("killed"), tests: [{ path: "src/other.mutation-kill.test.ts", sha256: "x" }], killedTests: ["src/other.mutation-kill.test.ts"] };
		expect(killProofNudge({ root: "/repo", relPath: REL, readIndex: () => index(other), certify: certified })).not.toBeNull();
	});
});

describe("collectKillProofWriteWarning — scope", () => {
	it("N1: an ordinary test file is out of scope (self-declared files only)", () => {
		expect(collectKillProofWriteWarning(event("/repo/src/lib/clamp.test.ts"))).toEqual([]);
	});
	it("N2: a read is not a write", () => {
		expect(collectKillProofWriteWarning(event(`/repo/${REL}`, "Read"))).toEqual([]);
	});
	it("P1: a mutation-directed test write with no receipts yields exactly one nudge", () => {
		const warnings = collectKillProofWriteWarning(event(`/repo/${REL}`));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(`[interlinked:kill-proof] ${REL}: no executed kill proof`);
	});
});

describe("killProofNudge — command form (batch when several survivors are known)", () => {
	it("P6: more than one known survivor of the companion source prints the --all-survivors command and drops the ids hint", () => {
		const text = killProofNudge({ root: "/repo", relPath: REL, readIndex: () => index(), certify: certified, knownSurvivors: () => ({ source: "src/lib/clamp.ts", count: 3 }) });
		expect(text).toContain(`prove it: interlinked tests prove-kill --file src/lib/clamp.ts --test ${REL} --all-survivors.`);
		expect(text).not.toContain("--mutant <id>");
		expect(text).not.toContain("ids: interlinked mutation survivors");
	});
	it("P7: the stale-proof wording uses the same batch command", () => {
		const text = killProofNudge({ root: "/repo", relPath: REL, readIndex: () => index(row("killed")), certify: () => stale(), knownSurvivors: () => ({ source: "src/lib/clamp.ts", count: 2 }) });
		expect(text).toContain(`Re-run: interlinked tests prove-kill --file src/lib/clamp.ts --test ${REL} --all-survivors`);
	});
	it("N3: one known survivor, or none known, keeps the single-mutant command with the ids hint; the firing rule is unchanged", () => {
		for (const known of [{ source: "src/lib/clamp.ts", count: 1 }, null]) {
			const text = killProofNudge({ root: "/repo", relPath: REL, readIndex: () => index(), certify: certified, knownSurvivors: () => known });
			expect(text).toContain(`prove it: interlinked tests prove-kill --mutant <id> --test ${REL} (ids: interlinked mutation survivors --file <source>).`);
		}
		expect(killProofNudge({ root: "/repo", relPath: REL, readIndex: () => index(row("killed")), certify: certified, knownSurvivors: () => ({ source: "src/lib/clamp.ts", count: 9 }) })).toBeNull();
	});
});
