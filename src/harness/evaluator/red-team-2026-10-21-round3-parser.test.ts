// Regression pins for the red-team 2026-10-21 round-3 re-attack on the
// coverage-edit high-water ("coverage-high-water" group,
// scratch/2026-10-21-red-team/round2-result.json `stillOpen`, rows V01–V06 and
// V16). Root cause: the baseline-integrity gate parsed water-lines with the
// JSONC-tolerant `safeJsonParse` while every runtime consumer parses with strict
// JSON.parse, and an unparseable post-image yielded no finding. So a trailing
// comma, a `//` line, a BOM, an empty file or a missing brace made the gate see
// "no change" while the runtime saw "no ledger" (every hw and floor gone), and a
// `/* … */` pair spanning two string keys hid a lowered duplicate from the gate
// only. V16: `per_edit_coverage.drop_epsilon` is a tolerance the high-water
// check subtracts, and any value was honoured.
// Invariant pinned here: the gate and the runtime read a water-line with ONE
// strict parser (water-line-json.ts); for an existing water-line, a post-image
// the runtime cannot read the same way (unparseable, empty, duplicate keys) is a
// loosening at PreToolUse AND in the effect arm (restored); drop_epsilon may
// only tighten. Fixtures are disposable OS-temp dirs; the repository's real
// `.interlinked/*.json` and tsconfig files are never touched.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The per-edit coverage cases stub the runner; no real process may spawn.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: () => {
			throw new Error("mocked-no-spawn");
		},
	};
});

import { readFileCoverageHighWater, writeFileCoverageBaseline } from "../coverage-obligation-ledger.js";
import type { CoverageRunner, CoverageRunResult } from "../coverage-runner.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import { resetRepoProfileCache } from "../repo-profile.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";
import { makeGuardRules } from "./__tests__/fixtures.js";
import { detectBaselineLoosening, restoreBaseline, writeUndoRecord } from "./baseline-effect-guard.js";
import { detectBaselineGaming, evaluateBaselineIntegrityForEvent } from "./baseline-integrity-gate.js";
import { detectConfigLoosening } from "./config-loosening-gate.js";
import { type CoverageWriteDeps, checkCoverageWrite } from "./coverage-write-guard.js";

const REL = ".interlinked/coverage-edit-baseline.json";
const SCOPE = "scoped:2e8325f282bd";
const LEDGER_VALUE = { "src/m.ts": { f: 0.996, scope: SCOPE, hw: 1 }, "src/n.ts": 1 };
const LEDGER = `${JSON.stringify(LEDGER_VALUE, null, 2)}\n`;

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-rt-round3-parser-"));
	mkdirSync(join(root, ".interlinked"), { recursive: true });
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "m.ts"), "export const m = 1;\n");
	writeFileSync(join(root, "src", "n.ts"), "export const n = 1;\n");
	writeFileSync(join(root, REL), LEDGER);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "rt-round3-parser", devDependencies: { vitest: "^3.0.0" } }),
	);
	resetRepoProfileCache();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	resetRepoProfileCache();
});

function event(toolName: string, toolInput: Record<string, unknown>): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "rt-round3-parser",
		agent_source: "claude",
		tool_name: toolName,
		tool_input: { file_path: join(root, REL), ...toolInput },
		timestamp: "2026-10-21T00:00:00.000Z",
		cwd: root,
	};
}

function gateWrite(content: string): HarnessDecision | null {
	return evaluateBaselineIntegrityForEvent(event("Write", { content }));
}

/** The text lands on disk (as a tool would leave it); the effect arm must flag
 *  it as a restorable loosening and the undo record must put the bytes back. */
function expectEffectArmRestores(afterText: string): void {
	writeFileSync(join(root, REL), afterText);
	const loosenings = detectBaselineLoosening({ [REL]: LEDGER }, { [REL]: afterText }, root);
	expect(loosenings).toHaveLength(1);
	expect(loosenings[0]?.recordOnly).toBeUndefined();
	writeUndoRecord(root, "rt-round3-call", loosenings);
	expect(restoreBaseline(root, "rt-round3-call")).toBe(1);
	expect(readFileSync(join(root, REL), "utf8")).toBe(LEDGER);
}

/** The runtime's view of the post-image: strict JSON.parse reads no ledger. */
function expectRuntimeReadsNoHighWater(afterText: string): void {
	writeFileSync(join(root, REL), afterText);
	expect(readFileCoverageHighWater(root, "src/m.ts")).toBeNull();
	writeFileSync(join(root, REL), LEDGER);
}

describe("round 3 parser differential — positive (must fire)", () => {
	it("P1 (V01): a trailing comma before the closing brace blocks, and the effect arm restores", () => {
		const after = LEDGER.replace('"src/n.ts": 1\n}', '"src/n.ts": 1,\n}');
		expectRuntimeReadsNoHighWater(after);
		const decision = gateWrite(after);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/not strict JSON \(.+\)/);
		expectEffectArmRestores(after);
	});

	it("P2 (V02): a leading `//` comment line blocks, and the effect arm restores", () => {
		const after = `// per-edit ledger\n${LEDGER}`;
		expectRuntimeReadsNoHighWater(after);
		expect(gateWrite(after)?.decision).toBe("block");
		expectEffectArmRestores(after);
	});

	it("P3 (V03): a lowered duplicate key hidden between `/*` and `*/` keys blocks as a duplicate", () => {
		const after = `{"src/m.ts":{"f":0.996,"scope":"${SCOPE}","hw":1},"a/*":0,"src/m.ts":{"f":0.1,"scope":"${SCOPE}"},"b*/":0,"src/n.ts":1}\n`;
		const decision = gateWrite(after);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/repeats \$\["src\/m\.ts"\]/);
		expectEffectArmRestores(after);
	});

	it("P4 (V04): an empty post-image blocks, naming the empty file, and the effect arm restores", () => {
		const decision = gateWrite("");
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/the file is empty/);
		expectEffectArmRestores("");
	});

	it("P5 (V05): a UTF-8 byte-order mark before unchanged JSON blocks, naming the BOM", () => {
		const after = `﻿${LEDGER}`;
		expectRuntimeReadsNoHighWater(after);
		const decision = gateWrite(after);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/byte-order mark/);
		expectEffectArmRestores(after);
	});

	it("P6 (V06): an Edit that removes the closing brace blocks, and the effect arm restores", () => {
		const decision = evaluateBaselineIntegrityForEvent(
			event("Edit", { old_string: '"src/n.ts": 1\n}', new_string: '"src/n.ts": 1\n' }),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/not strict JSON/);
		expectEffectArmRestores(LEDGER.replace('"src/n.ts": 1\n}', '"src/n.ts": 1\n'));
	});

	it("P7: a non-object post-image of an object water-line blocks", () => {
		expect(gateWrite("null\n")?.decision).toBe("block");
		expect(gateWrite("[]\n")?.reason).toMatch(/not a JSON object/);
	});
});

describe("round 3 parser differential — negative (must not fire)", () => {
	it("N1: a strict reformat of the same values is allowed", () => {
		expect(gateWrite(`${JSON.stringify(LEDGER_VALUE)}\n`)).toBeNull();
	});

	it("N2: raising f with the scope untouched is allowed", () => {
		const raised = { ...LEDGER_VALUE, "src/m.ts": { f: 0.998, scope: SCOPE, hw: 1 } };
		expect(gateWrite(JSON.stringify(raised, null, 2))).toBeNull();
	});

	it("N3: unique keys that contain `/*` and `*/` are judged on their strict values", () => {
		writeFileSync(join(root, REL), `{"a/*.ts":0.5,"src/n.ts":1,"b*/.ts":0.5}\n`);
		expect(gateWrite(`{"a/*.ts":0.6,"src/n.ts":1,"b*/.ts":0.5}\n`)).toBeNull();
		// The same shape with the middle entry LOWERED is caught: the JSONC strip
		// used to delete `"src/n.ts":1` from both sides and see no change.
		expect(gateWrite(`{"a/*.ts":0.5,"src/n.ts":0.2,"b*/.ts":0.5}\n`)?.decision).toBe("block");
	});

	it("N4: a pre-image that is not strict JSON holds no water-line, so a strict rewrite is allowed", () => {
		writeFileSync(join(root, REL), `﻿${LEDGER}`);
		expect(gateWrite(LEDGER)).toBeNull();
	});

	it("N5: tsconfig files stay JSONC — comments and trailing commas are not findings there", () => {
		const before = '{\n  // strict\n  "compilerOptions": { "strict": true, },\n}\n';
		const after = '{\n  /* still strict */\n  "compilerOptions": { "strict": true, "noEmit": true, },\n}\n';
		expect(detectConfigLoosening("/repo/tsconfig.json", before, after)).toEqual([]);
	});

	it("N6: the pure detector agrees with the gate on a creation and on a non-water-line", () => {
		expect(detectBaselineGaming(join(root, REL), "", "{,}")).toEqual([]);
		expect(detectBaselineGaming(join(root, "notes.json"), LEDGER, "")).toEqual([]);
	});
});

// ---- V16: drop_epsilon is tighten-only ----------------------------------------

function coverageRules(dropEpsilon?: number): GuardRulesConfig {
	return {
		...makeGuardRules(),
		per_edit_coverage: {
			enabled: true,
			mode: "block",
			budget_ms: 25_000,
			languages: ["js", "ts"],
			...(dropEpsilon === undefined ? {} : { drop_epsilon: dropEpsilon }),
		},
	};
}

function runnerAt(pct: number): CoverageWriteDeps {
	const perFile = new Map<string, PerFileCoverage>();
	perFile.set("src/a.ts", { filePath: "src/a.ts", mtime: 0, functions: [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: pct }] });
	const result: CoverageRunResult = { suiteMs: 1000, perFile, ok: true, testsPassed: true };
	const runner: CoverageRunner = { run: async () => result };
	return {
		runnerFor: () => runner,
		createOverlay: (projectRoot, editedRelPath) => ({
			overlayRoot: join(projectRoot, ".interlinked", ".cov-overlay-stub"),
			editedFileInOverlay: join(projectRoot, ".interlinked", ".cov-overlay-stub", editedRelPath),
			cleanup: () => {},
		}),
		clock: () => 0,
		cyclomaticFor: () => () => [],
	};
}

async function coverageEdit(pct: number, dropEpsilon?: number): Promise<HarnessDecision | null> {
	writeFileCoverageBaseline(root, "src/a.ts", 1, "full");
	const write: HarnessEvent = {
		hook_event: "PreToolUse",
		session_id: "rt-round3-v16",
		agent_source: "claude",
		tool_name: "Write",
		tool_input: { file_path: join(root, "src", "a.ts"), content: "export function f() {\n  return 1;\n}\n" },
		timestamp: "2026-10-21T00:00:00.000Z",
		cwd: root,
	};
	return checkCoverageWrite(write, coverageRules(dropEpsilon), runnerAt(pct));
}

describe("round 3 drop_epsilon water-line — positive (must fire)", () => {
	it("P8 (V16): drop_epsilon 0.5 is ignored with a warning, so a drop to 66.7% below hw 1 blocks", async () => {
		const decision = await coverageEdit(66.7, 0.5);
		expect(decision?.decision).toBe("block");
		expect(decision?.warnings?.join("\n")).toMatch(/drop_epsilon 0\.5 is above the built-in 0\.005 and is ignored/);
	});

	it("P9: the built-in tolerance is 0.005 in both modules (guard cap and decision default agree)", async () => {
		// Decision default: a 0.4-point drop passes, a 0.6-point drop blocks.
		expect(await coverageEdit(99.6)).toBeNull();
		expect((await coverageEdit(99.4))?.decision).toBe("block");
		// Guard cap: 0.005 applies silently, 0.0051 is refused with a warning.
		expect(await coverageEdit(99.6, 0.005)).toBeNull();
		expect((await coverageEdit(100, 0.0051))?.warnings?.join("\n")).toMatch(/is ignored/);
	});
});

describe("round 3 drop_epsilon water-line — negative (must not fire)", () => {
	it("N7: a drop_epsilon below the default tightens the tolerance with no warning", async () => {
		const decision = await coverageEdit(99.7, 0.001);
		expect(decision?.decision).toBe("block");
		expect(decision?.warnings ?? []).toEqual([]);
	});

	it("N8: an absent drop_epsilon on a clean edit yields no decision and no warning", async () => {
		expect(await coverageEdit(100)).toBeNull();
	});
});
