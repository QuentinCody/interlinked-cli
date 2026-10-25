// Regression pins for the red-team 2026-10-21 round-4 finding on cap-style
// water-lines. Root cause: the shared loosening detector
// (`detectBaselineGaming`, used by the PreToolUse gate AND the effect arm in
// baseline-effect-guard.ts) compared only keys present and numeric on BOTH
// sides, so `.interlinked/metric-caps.json` with max_cyclomatic 22 and
// crap_threshold 25 rewritten to `{}` — or with max_cyclomatic dropped — read
// as "unchanged" while the runtime fell back to the looser defaults.
// Re-run: npx tsx scratch/2026-10-21-round3/verify-effect-arm.mts.
// Invariant pinned here: every cap is compared by the value the runtime would
// actually use — the file value when present and valid, else the runtime
// default (imported from the consumer, never copied). A removed or invalid key
// whose default is looser is a loosening; an equal or tighter default is not.
// Fixtures are disposable OS-temp dirs; the repository's real `.interlinked/`
// files are never touched.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_LINES } from "../large-file-policy.js";
import { DEFAULT_CRAP_THRESHOLD, DEFAULT_MAX_COGNITIVE_CAP, DEFAULT_MAX_CYCLOMATIC } from "../metric-caps.js";
import { DEFAULT_MIN_COVERAGE_PCT } from "../tested-file-policy.js";
import type { HarnessEvent } from "../types.js";
import { consumeBaselineSnapshot, rememberBaselineSnapshot } from "./baseline-effect-guard.js";
import { detectBaselineGaming, evaluateBaselineIntegrityForEvent } from "./baseline-integrity-gate.js";
import { BASELINE_RESTORE_PREFIX, resetConfigDiscovery } from "./config-effect-guard.js";

const CAPS = "/repo/.interlinked/metric-caps.json";
const LARGE = "/repo/.interlinked/large-files-baseline.json";
const UNTESTED = "/repo/.interlinked/untested-files-baseline.json";
const SKIPPED = "/repo/.interlinked/skipped-tests-baseline.json";
const LEDGER = "/repo/.interlinked/function-complexity-baseline.json";

/** The verified gap: tighter than DEFAULT_MAX_CYCLOMATIC and DEFAULT_CRAP_THRESHOLD. */
const TIGHT = { version: 1, max_cyclomatic: 22, crap_threshold: 25 };

function rules(file: string, before: unknown, after: unknown): string[] {
	return detectBaselineGaming(file, JSON.stringify(before), JSON.stringify(after)).map((f) => f.rule);
}

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "rt4-effective-caps-"));
	dirs.push(root);
	mkdirSync(join(root, ".interlinked"));
	for (const [rel, text] of Object.entries(files)) writeFileSync(join(root, rel), text);
	return root;
}

describe("metric-caps — positive (must fire): a removed or invalid cap with a looser default", () => {
	it("P1: `{}` loosens both caps to the runtime defaults", () => {
		const found = detectBaselineGaming(CAPS, JSON.stringify(TIGHT), "{}");
		expect(found.map((f) => f.rule).sort()).toEqual(["crap_threshold", "max_cyclomatic"]);
		const cyclo = found.find((f) => f.rule === "max_cyclomatic");
		expect(cyclo?.before).toBe(22);
		expect(cyclo?.after).toBe(DEFAULT_MAX_CYCLOMATIC);
		expect(cyclo?.message).toContain("max_cyclomatic removed");
		expect(found.find((f) => f.rule === "crap_threshold")?.after).toBe(DEFAULT_CRAP_THRESHOLD);
	});

	it("P2: dropping max_cyclomatic alone is a loosening of that cap only", () => {
		expect(rules(CAPS, TIGHT, { version: 1, crap_threshold: 25 })).toEqual(["max_cyclomatic"]);
	});

	it("P3: a cap set to a non-number reads as the default the runtime falls back to", () => {
		const found = detectBaselineGaming(CAPS, JSON.stringify(TIGHT), JSON.stringify({ ...TIGHT, max_cyclomatic: "22" }));
		expect(found.map((f) => f.rule)).toEqual(["max_cyclomatic"]);
		expect(found[0]?.message).toContain('set to "22", which the runtime rejects');
	});

	it("P4: a cap set to null, 0 or a negative number reads as the default", () => {
		for (const bad of [null, 0, -1]) {
			expect(rules(CAPS, TIGHT, { ...TIGHT, max_cyclomatic: bad })).toEqual(["max_cyclomatic"]);
		}
	});

	it("P5: removing max_predicate_drift leaves no limit at all", () => {
		const found = detectBaselineGaming(CAPS, JSON.stringify({ ...TIGHT, max_predicate_drift: 0 }), JSON.stringify(TIGHT));
		expect(found.map((f) => f.rule)).toEqual(["max_predicate_drift"]);
		expect(found[0]?.message).toContain("0→no limit");
	});

	it("P6: removing a min_coverage floor drops the runtime floor to 0", () => {
		expect(rules(CAPS, { ...TIGHT, min_coverage: 40 }, TIGHT)).toEqual(["min_coverage"]);
		expect(rules(CAPS, { ...TIGHT, min_coverage: 40 }, { ...TIGHT, min_coverage: null })).toEqual(["min_coverage"]);
	});

	it("P7: max_lines falls back to the large-files baseline cap, which may be looser than the default", () => {
		const root = fixture({ ".interlinked/large-files-baseline.json": '{"version":1,"max_lines":800,"files":{}}' });
		const file = join(root, ".interlinked/metric-caps.json");
		const found = detectBaselineGaming(file, JSON.stringify({ max_lines: DEFAULT_MAX_LINES }), "{}");
		expect(found.map((f) => f.rule)).toEqual(["max_lines"]);
		expect(found[0]?.after).toBe(800);
	});

	it("P8: the PreToolUse gate blocks a Write of `{}` over the tight caps", () => {
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "rt4",
			agent_source: "claude",
			tool_name: "Write",
			tool_input: { file_path: CAPS, content: "{}" },
			timestamp: "2026-10-21T00:00:00Z",
			cwd: "/repo",
			dry_run: true,
		};
		const decision = evaluateBaselineIntegrityForEvent(event, { getDisk: () => JSON.stringify(TIGHT) });
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toContain("[max_cyclomatic]");
	});
});

describe("metric-caps — negative (must not fire): equal or tighter defaults, reformatting", () => {
	it("N1: removing a cap equal to its default is not a loosening", () => {
		expect(rules(CAPS, { max_cyclomatic: DEFAULT_MAX_CYCLOMATIC, max_cognitive: DEFAULT_MAX_COGNITIVE_CAP }, {})).toEqual([]);
		expect(rules(CAPS, { crap_threshold: DEFAULT_CRAP_THRESHOLD, min_coverage: 0 }, {})).toEqual([]);
	});

	it("N2: removing a cap that was already looser than the default tightens it", () => {
		expect(rules(CAPS, { max_cyclomatic: DEFAULT_MAX_CYCLOMATIC + 10 }, {})).toEqual([]);
	});

	it("N3: an invalid cap that is removed stays at the same default", () => {
		expect(rules(CAPS, { max_cyclomatic: "x" }, {})).toEqual([]);
	});

	it("N4: reformatting the same values is not a loosening", () => {
		const reformatted = `{\n  "crap_threshold": 25,\n  "max_cyclomatic": 22,\n  "version": 1\n}\n`;
		expect(detectBaselineGaming(CAPS, JSON.stringify(TIGHT), reformatted)).toEqual([]);
	});

	it("N5: max_lines removed while the large-files fallback equals it", () => {
		const root = fixture({ ".interlinked/large-files-baseline.json": `{"version":1,"max_lines":${DEFAULT_MAX_LINES},"files":{}}` });
		expect(detectBaselineGaming(join(root, ".interlinked/metric-caps.json"), JSON.stringify({ max_lines: DEFAULT_MAX_LINES }), "{}")).toEqual([]);
	});
});

describe("other cap-style water-lines — positive (must fire)", () => {
	it("P1: large-files max_lines dropped or `{}` falls back to the looser default", () => {
		const before = { version: 1, max_lines: 400, files: {} };
		expect(rules(LARGE, before, { version: 1, files: {} })).toEqual(["max_lines"]);
		expect(rules(LARGE, before, {})).toEqual(["max_lines"]);
		expect(rules(LARGE, before, { ...before, max_lines: "400" })).toEqual(["max_lines"]);
	});

	it("P2: a new grandfather entry is judged against the effective cap", () => {
		const after = { version: 1, files: { "src/new.ts": DEFAULT_MAX_LINES + 1 } };
		expect(rules(LARGE, { version: 1, max_lines: 400, files: {} }, after)).toEqual(["max_lines", "grandfather-new:src/new.ts"]);
	});

	it("P3: untested-files min_coverage_pct removed or null falls back to the lower default", () => {
		const before = { version: 1, min_coverage_pct: DEFAULT_MIN_COVERAGE_PCT + 20, files: [] };
		expect(rules(UNTESTED, before, { version: 1, files: [] })).toEqual(["min_coverage_pct"]);
		expect(rules(UNTESTED, before, { ...before, min_coverage_pct: null })).toEqual(["min_coverage_pct"]);
	});

	it("P4: a ledger section that only becomes valid now is new, so its entries are additions", () => {
		const entries = [{ file: "src/a.ts", name: "big", line: 1, value: 30 }];
		const before = { version: 1, metrics: { cyclomatic: { cap: "16", entries } } };
		const after = { version: 1, metrics: { cyclomatic: { cap: 16, entries } } };
		expect(rules(LEDGER, before, after)).toEqual(["cyclomatic:grandfather-new:src/a.ts:big"]);
	});

	it("P5: a ledger entry the runtime drops (no line) grandfathers nothing", () => {
		const before = { version: 1, metrics: { cyclomatic: { cap: 16, entries: [{ file: "src/a.ts", name: "big", value: 30 }] } } };
		const after = { version: 1, metrics: { cyclomatic: { cap: 16, entries: [{ file: "src/a.ts", name: "big", line: 1, value: 30 }] } } };
		expect(rules(LEDGER, before, after)).toEqual(["cyclomatic:grandfather-new:src/a.ts:big"]);
	});
});

describe("other cap-style water-lines — negative (must not fire)", () => {
	it("N1: large-files max_lines equal to the default may be removed", () => {
		expect(rules(LARGE, { version: 1, max_lines: DEFAULT_MAX_LINES, files: {} }, { version: 1, files: {} })).toEqual([]);
	});

	it("N2: untested-files floor below the default may be removed (the default is higher)", () => {
		expect(rules(UNTESTED, { version: 1, min_coverage_pct: DEFAULT_MIN_COVERAGE_PCT - 10, files: [] }, { version: 1, files: [] })).toEqual([]);
	});

	it("N3: skipped-tests max_skipped removed falls back to 0, which is tighter", () => {
		expect(rules(SKIPPED, { version: 1, max_skipped: 2, files: {} }, { version: 1, files: {} })).toEqual([]);
	});

	it("N4: a ledger section whose cap becomes invalid reads as removed — the documented allowed move", () => {
		const entries = [{ file: "src/a.ts", name: "big", line: 1, value: 30 }];
		const before = { version: 1, metrics: { cyclomatic: { cap: 16, entries } } };
		const after = { version: 1, metrics: { cyclomatic: { cap: null, entries } } };
		expect(rules(LEDGER, before, after)).toEqual([]);
	});
});

describe("effect arm — the probe's two failing rows", () => {
	function runEffect(after: string): { message: string | null; bytes: string } {
		resetConfigDiscovery();
		const tight = `${JSON.stringify(TIGHT)}\n`;
		const root = fixture({ ".interlinked/metric-caps.json": tight });
		const key = `rt4-${Math.random()}`;
		rememberBaselineSnapshot(key, root);
		writeFileSync(join(root, ".interlinked/metric-caps.json"), after);
		const message = consumeBaselineSnapshot(key, root, { command: "printf" });
		return { message, bytes: readFileSync(join(root, ".interlinked/metric-caps.json"), "utf8") };
	}

	it("P1: `{}` is restored to the pre-call bytes", () => {
		const { message, bytes } = runEffect("{}");
		expect(message?.startsWith(BASELINE_RESTORE_PREFIX)).toBe(true);
		expect(bytes).toBe(`${JSON.stringify(TIGHT)}\n`);
	});

	it("P2: a dropped max_cyclomatic is restored to the pre-call bytes", () => {
		const { message, bytes } = runEffect('{"version":1,"crap_threshold":25}\n');
		expect(message?.startsWith(BASELINE_RESTORE_PREFIX)).toBe(true);
		expect(bytes).toBe(`${JSON.stringify(TIGHT)}\n`);
	});

	it("N1: an honest tightening is kept", () => {
		const tighter = '{"version":1,"max_cyclomatic":18,"crap_threshold":25}\n';
		const { message, bytes } = runEffect(tighter);
		expect(message?.startsWith(BASELINE_RESTORE_PREFIX) ?? false).toBe(false);
		expect(bytes).toBe(tighter);
	});
});
