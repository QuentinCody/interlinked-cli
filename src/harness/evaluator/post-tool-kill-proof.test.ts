import { describe, expect, it } from "vitest";
import type { KillProofIndex, KillProofIndexRow } from "../kill-proof/receipt.js";
import type { HarnessEvent } from "../types.js";
import { collectKillProofWriteWarning, killProofNudge } from "./post-tool-kill-proof.js";

const REL = "src/lib/clamp.mutation-kill.test.ts";
const row = (verdict: KillProofIndexRow["verdict"], id = "0123456789abcdef", killedTests = verdict === "killed" ? [REL] : []): KillProofIndexRow => ({
	id, verdict, provedAt: "2026-11-04T23:00:00.000Z", mutant: "m", source: { path: "src/lib/clamp.ts", sha256: "s" }, tests: [{ path: REL, sha256: "t" }], killedTests,
});
const index = (...receipts: KillProofIndexRow[]): KillProofIndex => ({ version: 1, receipts });
const fresh = () => [] as string[];
const event = (file_path: string, tool_name = "Write"): HarnessEvent => ({ hook_event: "PostToolUse", session_id: "s", agent_source: "claude", tool_name, tool_input: { file_path }, timestamp: "2026-11-04T23:00:00.000Z", cwd: "/repo" }) as unknown as HarnessEvent;

describe("killProofNudge — positive (must fire)", () => {
	it("P1: no receipt at all names the prove-kill command and says what is not proof", () => {
		const text = killProofNudge({ root: "/repo", relPath: REL, readIndex: () => index(), freshness: fresh });
		expect(text).toContain("[interlinked:kill-proof]");
		expect(text).toContain(`interlinked tests prove-kill --mutant <id> --test ${REL}`);
		expect(text).toContain("not proof");
	});
	it("P2: a killed receipt whose bytes or runtime changed is reported as stale, with the re-run command", () => {
		const text = killProofNudge({ root: "/repo", relPath: REL, readIndex: () => index(row("killed")), freshness: () => ["test changed"] });
		expect(text).toContain("1 kill proof(s) went stale");
		expect(text).toContain("Re-run:");
	});
	it("P3: survived or inconclusive receipts count as runs that did not kill through this file", () => {
		const text = killProofNudge({ root: "/repo", relPath: REL, readIndex: () => index(row("survived", "aaaaaaaaaaaaaaaa"), row("inconclusive", "bbbbbbbbbbbbbbbb")), freshness: fresh });
		expect(text).toContain("2 recorded run(s) did not kill through this file (survived, inconclusive)");
	});
	it("P4: a killed receipt that names this file but whose kill came from ANOTHER named file does not certify it (review R2)", () => {
		const other = { ...row("killed"), tests: [{ path: REL, sha256: "t" }, { path: "src/lib/other.test.ts", sha256: "u" }], killedTests: ["src/lib/other.test.ts"] };
		expect(killProofNudge({ root: "/repo", relPath: REL, readIndex: () => index(other), freshness: fresh })).toContain("no executed kill proof covers");
	});
	it("P5: an index row whose receipt file is unreadable is nothing (review R8)", () => {
		expect(killProofNudge({ root: "/repo", relPath: REL, readIndex: () => index(row("killed")), freshness: () => null })).toContain("went stale");
	});
});

describe("killProofNudge — negative (must not fire)", () => {
	it("N1: a fresh killed receipt that killed through this file silences the nudge", () => {
		expect(killProofNudge({ root: "/repo", relPath: REL, readIndex: () => index(row("killed")), freshness: fresh })).toBeNull();
	});
	it("N2: a fresh killed receipt for ANOTHER test file does not count", () => {
		const other = { ...row("killed"), tests: [{ path: "src/other.mutation-kill.test.ts", sha256: "x" }], killedTests: ["src/other.mutation-kill.test.ts"] };
		expect(killProofNudge({ root: "/repo", relPath: REL, readIndex: () => index(other), freshness: fresh })).not.toBeNull();
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
