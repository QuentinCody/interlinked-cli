import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	evaluateBashEditObligationGate,
	openBashEditObligations,
	recordBashEditObligations,
	resetBashEditObligationsForTesting,
} from "./bash-edit-obligations.js";
import type { HarnessEvent } from "./types.js";

let cwd = "";

// A pre_block-class finding the registry always carries: eval() injection.
const BAD_LINE = `eval(userInput);\n`;
const CLEAN = `export const ok = 1;\n`;

function writeSrc(rel: string, content: string): string {
	const abs = join(cwd, rel);
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(abs, content);
	return abs;
}

function editEvent(toolName: string, filePath?: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s1",
		agent_source: "claude",
		tool_name: toolName,
		tool_input: filePath ? { file_path: filePath } : {},
		timestamp: "2026-08-25T00:00:00.000Z",
		cwd,
	} as HarnessEvent;
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "bash-obligation-"));
	resetBashEditObligationsForTesting();
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("recordBashEditObligations — positive (must open)", () => {
	it("P1: a bash-edited file whose post-state carries a pre_block finding opens an obligation and returns a warning", () => {
		const abs = writeSrc("src/a.ts", BAD_LINE);
		const warning = recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false });
		expect(warning).toContain("[interlinked:bash-edit-obligation]");
		expect(openBashEditObligations(cwd).length).toBe(1);
	});

	it("P2: the obligation survives an in-memory reset via the JSON store (daemon restart shape)", () => {
		const abs = writeSrc("src/a.ts", BAD_LINE);
		recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false });
		resetBashEditObligationsForTesting();
		expect(openBashEditObligations(cwd).length).toBe(1);
	});
});

describe("recordBashEditObligations — negative (must stay silent)", () => {
	it("N1: a clean bash-edited file opens nothing", () => {
		const abs = writeSrc("src/a.ts", CLEAN);
		expect(recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false })).toBeNull();
		expect(openBashEditObligations(cwd).length).toBe(0);
	});

	it("N2: dry_run records nothing", () => {
		const abs = writeSrc("src/a.ts", BAD_LINE);
		recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: true });
		expect(openBashEditObligations(cwd).length).toBe(0);
	});

	// 2026-08-27 daemon-melt regression pins: `.interlinked/` tool state and
	// oversized data files are never obligation-eligible — a 45MB gitignored
	// mutation-manifest.json obligation made every tool call re-scan it
	// (73.7% of daemon CPU in stripComments) until the daemon read as zombie.
	it("N3: a finding-bearing file under .interlinked/ opens nothing (tool state, not code)", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const abs = join(cwd, ".interlinked", "mutation-manifest.json");
		writeFileSync(abs, `{"snippet":"${BAD_LINE.trim()}"}\n${BAD_LINE}`);
		expect(recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false })).toBeNull();
		expect(openBashEditObligations(cwd).length).toBe(0);
	});

	it("N4: a finding-bearing file over the size bound opens nothing (data, not per-edit code)", () => {
		const big = BAD_LINE + "// pad\n".repeat(400_000); // > 2MB
		const abs = writeSrc("src/huge.ts", big);
		expect(recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false })).toBeNull();
		expect(openBashEditObligations(cwd).length).toBe(0);
	});

	it("P4: a dry_run gate evaluation observes a fixed obligation without mutating memory or disk", () => {
		const abs = writeSrc("src/a.ts", BAD_LINE);
		recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false });
		writeFileSync(abs, CLEAN); // finding fixed on disk
		const dryEvent = { ...editEvent("Write", join(cwd, "src/other.ts")), dry_run: true } as HarnessEvent;
		// A dry run must decide from disk truth (fixed ⇒ allow) ...
		expect(evaluateBashEditObligationGate(dryEvent, "Write", [])).toBeNull();
		// ... but must NOT have consumed the row: the store still carries it,
		// and the next REAL evaluation both allows and persists the discharge.
		const stored = readFileSync(join(cwd, ".interlinked", "bash-edit-obligations.json"), "utf-8");
		expect(stored).toContain("src/a.ts");
		expect(evaluateBashEditObligationGate(editEvent("Write", join(cwd, "src/other.ts")), "Write", [])).toBeNull();
		const after = readFileSync(join(cwd, ".interlinked", "bash-edit-obligations.json"), "utf-8");
		expect(after).not.toContain("src/a.ts");
	});

	it("P3: a poisoned store row on an ineligible path self-discharges on the next gate evaluation", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(join(cwd, ".interlinked", "big.json"), BAD_LINE);
		// Simulate the pre-fix poisoned store: an obligation recorded on tool state.
		writeFileSync(
			join(cwd, ".interlinked", "bash-edit-obligations.json"),
			`${JSON.stringify({ ".interlinked/big.json": { checkIds: ["ubs_weak_hash"], opened_at: "", session_id: "s0" } })}\n`,
		);
		resetBashEditObligationsForTesting();
		const decision = evaluateBashEditObligationGate(editEvent("Write", join(cwd, "src/other.ts")), "Write", []);
		expect(decision).toBeNull();
		expect(openBashEditObligations(cwd).length).toBe(0);
	});
});

describe("evaluateBashEditObligationGate", () => {
	it("P1: blocks a Write to an UNRELATED file while an obligation is open", () => {
		const abs = writeSrc("src/a.ts", BAD_LINE);
		recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false });
		const decision = evaluateBashEditObligationGate(editEvent("Write", join(cwd, "src/other.ts")), "Write", []);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toContain("src/a.ts");
	});

	it("N1: an edit targeting the OBLIGATED file is allowed (that is the fix path)", () => {
		const abs = writeSrc("src/a.ts", BAD_LINE);
		recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false });
		expect(evaluateBashEditObligationGate(editEvent("Edit", abs), "Edit", [])).toBeNull();
	});

	it("N2: read-class tools are always allowed", () => {
		const abs = writeSrc("src/a.ts", BAD_LINE);
		recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false });
		expect(evaluateBashEditObligationGate(editEvent("Read", abs), "Read", [])).toBeNull();
		expect(evaluateBashEditObligationGate(editEvent("Grep"), "Grep", [])).toBeNull();
	});

	it("N3: the gate self-discharges once the finding is fixed on disk", () => {
		const abs = writeSrc("src/a.ts", BAD_LINE);
		recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false });
		writeFileSync(abs, CLEAN);
		expect(evaluateBashEditObligationGate(editEvent("Write", join(cwd, "src/other.ts")), "Write", [])).toBeNull();
		expect(openBashEditObligations(cwd).length).toBe(0);
	});

	it("N4: no obligations → null fast path", () => {
		expect(evaluateBashEditObligationGate(editEvent("Write", join(cwd, "src/x.ts")), "Write", [])).toBeNull();
	});
});

describe("store hygiene", () => {
	it("the JSON store lives under .interlinked and is valid JSON", () => {
		const abs = writeSrc("src/a.ts", BAD_LINE);
		recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false });
		const raw = readFileSync(join(cwd, ".interlinked", "bash-edit-obligations.json"), "utf-8");
		expect(() => JSON.parse(raw)).not.toThrow();
	});

	it("a directory passed as the edited path can't be read as code, so it opens nothing", () => {
		// statSync succeeds on a directory (it exists, well under the size
		// bound); only the subsequent readFileSync fails (EISDIR). Without the
		// catch around that read, this call would throw instead of returning
		// null, so this reaches the catch specifically, not the stat guard.
		const abs = join(cwd, "src", "adir");
		mkdirSync(abs, { recursive: true });
		expect(recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false })).toBeNull();
		expect(openBashEditObligations(cwd).length).toBe(0);
	});

	it("a store write blocked by a file where the directory should be still keeps the obligation in memory", () => {
		// mkdirSync(dirname(storeFile), { recursive: true }) throws EEXIST when
		// something already occupies that path as a plain file (verified: Node
		// refuses to treat it as a no-op the way it does for an existing dir).
		// persist() swallows that failure; the in-memory gate must still hold.
		writeFileSync(join(cwd, ".interlinked"), "not-a-directory");
		const abs = writeSrc("src/a.ts", BAD_LINE);
		const warning = recordBashEditObligations({ cwd, sessionId: "s1", filePath: abs, dryRun: false });
		expect(warning).toContain("[interlinked:bash-edit-obligation]");
		expect(openBashEditObligations(cwd).length).toBe(1);
	});
});
