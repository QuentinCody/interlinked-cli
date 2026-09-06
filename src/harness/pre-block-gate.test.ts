// Companion for the shared pre_block gate semantics: introduced-only blocking
// (multiset over normalized line text vs the on-disk baseline) + suppression
// honoring (inline directive + verify-suppressions.json). The regression this
// pins (bio-orchestrator, 2026-07): ONE pre-existing flagged line bricked a
// ~1,100-line file for every unrelated future edit, with no way to mark the
// line deliberate.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	lineList,
	type PreBlockCheckOutcome,
	preBlockIntroducedBlock,
	preexistingPreBlockWarnings,
	resolveDiskBaseline,
	runPreBlockRegistryGate,
	suppressionHint,
} from "./pre-block-gate.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pre-block-gate-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const FILE = "src/lib/client.ts";
// Fires ubs_hardcoded_localhost (pre_block) and nothing else.
const VIOLATION = "const URL = 'http://localhost:8000/api';";
const CLEAN = "export const api = process.env.API_URL;";

function outcomesFor(content: string, baseline?: string | null, projectRoot?: string) {
	return runPreBlockRegistryGate({
		content,
		filePath: FILE,
		baselineContent: baseline,
		projectRoot,
	});
}

describe("runPreBlockRegistryGate — introduced-only blocking", () => {
	it("counts a violation with no baseline (new file) as introduced — strict legacy shape", () => {
		const out = outcomesFor(`${VIOLATION}\n`, null);
		expect(out).toHaveLength(1);
		expect(out[0]?.checkId).toBe("ubs_hardcoded_localhost");
		expect(out[0]?.introduced).toHaveLength(1);
		expect(out[0]?.preexisting).toHaveLength(0);
	});

	it("classifies a baseline violation as pre-existing when an unrelated line is added (the reported wall)", () => {
		const baseline = `${VIOLATION}\n${CLEAN}\n`;
		const edited = `${VIOLATION}\n${CLEAN}\nexport const more = 1;\n`;
		const out = outcomesFor(edited, baseline);
		expect(out).toHaveLength(1);
		expect(out[0]?.introduced).toHaveLength(0);
		expect(out[0]?.preexisting).toHaveLength(1);
	});

	it("keys by normalized text, not line number — a moved flagged line stays pre-existing", () => {
		const baseline = `${VIOLATION}\n${CLEAN}\n`;
		const edited = `${CLEAN}\nexport const shifted = true;\n  ${VIOLATION}\n`;
		const out = outcomesFor(edited, baseline);
		expect(out[0]?.introduced).toHaveLength(0);
		expect(out[0]?.preexisting).toHaveLength(1);
	});

	it("a SECOND copy of an existing flagged line is introduced (multiset, not set)", () => {
		const baseline = `${VIOLATION}\n`;
		const edited = `${VIOLATION}\n${VIOLATION}\n`;
		const out = outcomesFor(edited, baseline);
		expect(out[0]?.introduced).toHaveLength(1);
		expect(out[0]?.preexisting).toHaveLength(1);
	});

	it("a brand-new violation blocks even when a different pre-existing one is present", () => {
		const baseline = `${VIOLATION}\n`;
		const edited = `${VIOLATION}\nconst OTHER = 'http://127.0.0.1:9999/x';\n`;
		const out = outcomesFor(edited, baseline);
		expect(out[0]?.introduced).toHaveLength(1);
		expect(out[0]?.introduced[0]?.text).toContain("127.0.0.1");
	});

	it("returns no outcome for clean content", () => {
		expect(outcomesFor(`${CLEAN}\n`, null)).toEqual([]);
	});
});

describe("runPreBlockRegistryGate — suppressions honored (the 'this line is intentional' seam)", () => {
	it("drops a finding whose line carries the inline interlinked-ignore directive", () => {
		const content = [
			"// interlinked-ignore: ubs_hardcoded_localhost — deliberate dev-only endpoint",
			VIOLATION,
			"",
		].join("\n");
		expect(outcomesFor(content, null)).toEqual([]);
	});

	it("does NOT suppress under a directive naming a different check", () => {
		const content = ["// interlinked-ignore: sql-injection — wrong check", VIOLATION, ""].join("\n");
		const out = outcomesFor(content, null);
		expect(out[0]?.introduced).toHaveLength(1);
	});

	it("honors a file-level entry in .interlinked/verify-suppressions.json", () => {
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		writeFileSync(
			join(root, ".interlinked", "verify-suppressions.json"),
			JSON.stringify({
				[FILE]: {
					ubs_hardcoded_localhost: { reason: "dev resolver", by: "qcody", at: "2026-07-11" },
				},
			}),
		);
		expect(outcomesFor(`${VIOLATION}\n`, null, root)).toEqual([]);
	});

	it("ignores the suppressions file for other paths", () => {
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		writeFileSync(
			join(root, ".interlinked", "verify-suppressions.json"),
			JSON.stringify({
				"src/other.ts": {
					ubs_hardcoded_localhost: { reason: "elsewhere", by: "qcody", at: "2026-07-11" },
				},
			}),
		);
		const out = outcomesFor(`${VIOLATION}\n`, null, root);
		expect(out[0]?.introduced).toHaveLength(1);
	});
});

describe("resolveDiskBaseline", () => {
	it("returns on-disk content for an existing file", () => {
		const p = join(root, "a.ts");
		writeFileSync(p, "abc");
		expect(resolveDiskBaseline(p)).toBe("abc");
	});

	it("returns null for a missing file or empty path", () => {
		expect(resolveDiskBaseline(join(root, "nope.ts"))).toBeNull();
		expect(resolveDiskBaseline("")).toBeNull();
	});

	it("returns null (not a throw) when the path exists but readFileSync rejects it (EISDIR)", () => {
		const dirPath = join(root, "a-directory.ts");
		mkdirSync(dirPath);
		expect(resolveDiskBaseline(dirPath)).toBeNull();
	});
});

describe("message helpers", () => {
	it("lineList caps at five with an ellipsis", () => {
		const many = Array.from({ length: 7 }, (_, i) => ({ line: i + 1, text: "x" }));
		expect(lineList(many)).toBe("L1, L2, L3, L4, L5, …");
		expect(lineList(many.slice(0, 2))).toBe("L1, L2");
	});

	it("suppressionHint names the exact check id and both exception surfaces", () => {
		const hint = suppressionHint("ubs_hardcoded_localhost");
		expect(hint).toContain("interlinked-ignore: ubs_hardcoded_localhost");
		expect(hint).toContain("verify-suppressions.json");
	});

	const outcome = (introduced: number[], preexisting: number[]): PreBlockCheckOutcome => ({
		checkId: "eval_usage",
		introduced: introduced.map((line) => ({ line, text: `eval @ ${line}` })),
		preexisting: preexisting.map((line) => ({ line, text: `eval @ ${line}` })),
		instruction: "Do not eval.",
		deferrable: false,
	});

	it("preBlockIntroducedBlock names introduced lines, notes pre-existing, and carries the escape", () => {
		const d = preBlockIntroducedBlock(outcome([12], [3]), "src/x.ts", ["w1"]);
		expect(d.decision).toBe("block");
		expect(d.rule_id).toBe("eval_usage");
		expect(d.reason).toContain("INTRODUCES 1 violation(s) at L12");
		expect(d.reason).toContain("1 pre-existing instance(s) at L3 did not block");
		expect(d.reason).toContain("interlinked-ignore: eval_usage");
		expect(d.warnings).toEqual(["w1"]);
	});

	it("preBlockIntroducedBlock omits the pre-existing note when there are none", () => {
		const d = preBlockIntroducedBlock(outcome([12], []), "src/x.ts", []);
		expect(d.reason).not.toContain("pre-existing");
	});

	it("preexistingPreBlockWarnings emits one warning per outcome with pre-existing findings only", () => {
		const warns = preexistingPreBlockWarnings(
			[outcome([], [3, 9]), outcome([], [])],
			"src/x.ts",
		);
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("2 pre-existing [eval_usage] finding(s) at L3, L9");
		expect(warns[0]).toContain("did not block");
	});
});
