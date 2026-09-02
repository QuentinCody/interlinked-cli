// Tests for the campaign-target half of the characterize-before-touch gate:
// editing a function the function-complexity ledger lists, with no test
// signal for its file in the session trajectory, blocks in block mode.
//
// No mocks — the gate reads the ledger, the on-disk file, and the session's
// written-file / test-run / command trajectory.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type GrandfatheredFunction,
	resetFunctionComplexityBaselineCache,
	saveFunctionComplexityBaseline,
} from "../function-complexity-baseline.js";
import { createFreshSession, trackCommand } from "../session-state-mutators.js";
import { resetUntestedFilesBaselineCache } from "../tested-file-policy.js";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../types.js";
import { evaluateCharacterizeForEvent } from "./characterize-before-touch.js";
import {
	evaluateCampaignTargetGate,
	hasTestSignalFor,
	touchedFunctions,
} from "./characterize-campaign-target.js";

/** `branches` if-statements → cyclomatic = branches + 1. */
function fnWith(name: string, branches: number, tag = ""): string {
	let s = `export function ${name}(a: number): number {\n\tlet r = 0;${tag}\n`;
	for (let i = 0; i < branches; i++) s += `\tif (a === ${i}) r += ${i};\n`;
	return `${s}\treturn r;\n}\n`;
}

const BIG = fnWith("big", 20);
const TINY = fnWith("tiny", 1);

type RunStatus = "pass" | "fail";

interface SessionSeed {
	files_written?: string[];
	/** A bare file records a green run; a tuple records the given status. */
	test_runs?: Array<string | [string, RunStatus]>;
	commands_run?: string[];
}

function makeSession(seed: SessionSeed = {}): SessionTrajectory {
	// SAFETY: the gate reads only these three trajectory fields; the cast is
	// sound because nothing else is touched (matches the sibling test convention).
	const test_runs = new Map<string, { status: RunStatus; at_step: number }>();
	for (const r of seed.test_runs ?? []) {
		const [f, status] = typeof r === "string" ? [r, "pass" as const] : r;
		test_runs.set(f, { status, at_step: 1 });
	}
	return {
		files_written: new Set(seed.files_written ?? []),
		test_runs,
		commands_run: seed.commands_run ?? [],
	} as unknown as SessionTrajectory;
}

let tmp: string;
let file: string;

function ledger(
	entries: GrandfatheredFunction[],
	metric: "cyclomatic" | "cognitive" = "cyclomatic",
): void {
	saveFunctionComplexityBaseline(tmp, {
		version: 1,
		metrics: { [metric]: { cap: 10, entries } },
	});
}

const BIG_ENTRY: GrandfatheredFunction = { file: "src/a.ts", name: "big", line: 1, value: 21 };

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-cct-"));
	mkdirSync(join(tmp, "src"), { recursive: true });
	file = join(tmp, "src", "a.ts");
	writeFileSync(file, BIG + TINY);
	resetFunctionComplexityBaselineCache();
	resetUntestedFilesBaselineCache();
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	resetFunctionComplexityBaselineCache();
	resetUntestedFilesBaselineCache();
});

function gate(toolInput: Record<string, unknown>, session = makeSession(), mode: "block" | "warn" | "off" = "block") {
	return evaluateCampaignTargetGate({ toolInput, cwd: tmp, session, mode });
}

describe("characterize-campaign-target — positive (must fire)", () => {
	it("P1: block mode blocks a Write that touches a ledger-listed function with no test signal", () => {
		ledger([BIG_ENTRY]);
		const d = gate({ file_path: file, content: fnWith("big", 20, " // touched") + TINY });
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("characterize_before_touch");
		expect(d?.reason).toContain("characterize first: src/a.ts:big is a campaign target");
		expect(d?.reason).toContain("characterization test at the public caller before decomposing");
		expect(d?.reason).toContain("a.test.ts");
	});

	it("P2: an Edit (old_string/new_string) inside the target blocks the same way", () => {
		ledger([BIG_ENTRY]);
		const d = gate({ file_path: file, old_string: "if (a === 0) r += 0;", new_string: "if (a === 0) r += 100;" });
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("src/a.ts:big");
	});

	it("P3: a function listed only under the cognitive section is still a target", () => {
		ledger([BIG_ENTRY], "cognitive");
		const d = gate({ file_path: file, content: fnWith("big", 20, " // touched") + TINY });
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("cognitive 21");
	});

	it("P4: removing the target outright (a decomposition) counts as touching it", () => {
		ledger([BIG_ENTRY]);
		const d = gate({ file_path: file, content: fnWith("part1", 9) + fnWith("part2", 9) + TINY });
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("src/a.ts:big");
	});

	it("P5: the event wrapper reaches the campaign gate in block mode (wiring pin)", () => {
		ledger([BIG_ENTRY]);
		// SAFETY: the wrapper reads only structural_checks.characterize_mode.
		const rules = { structural_checks: { characterize_mode: "block" } } as unknown as GuardRulesConfig;
		const event = {
			hook_event: "PreToolUse",
			session_id: "s",
			tool_name: "Write",
			tool_input: { file_path: file, content: fnWith("big", 20, " // touched") + TINY },
			cwd: tmp,
			dry_run: true,
			timestamp: "2026-09-01T00:00:00Z",
		} as unknown as HarnessEvent; // SAFETY: minimal event — the wrapper reads tool_input, cwd, dry_run only.
		const d = evaluateCharacterizeForEvent(event, rules, makeSession());
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("campaign target");
	});

	it("P6: a whole-suite run is not a per-file test signal", () => {
		ledger([BIG_ENTRY]);
		const session = makeSession({ commands_run: ["npx vitest run"], test_runs: ["__all_tests__"] });
		const d = gate({ file_path: file, content: fnWith("big", 20, " // touched") + TINY }, session);
		expect(d?.decision).toBe("block");
	});

	it("P8: a RED recorded companion run is not a signal — the edit still blocks", () => {
		ledger([BIG_ENTRY]);
		const session = makeSession({ test_runs: [[join(tmp, "src", "a.test.ts"), "fail"]] });
		const d = gate({ file_path: file, content: fnWith("big", 20, " // touched") + TINY }, session);
		expect(d?.decision).toBe("block");
	});

	it("P9: a dot-relative tool-input path (./src/a.ts) still matches the ledger's src/a.ts", () => {
		ledger([BIG_ENTRY]);
		const d = gate({ file_path: "./src/a.ts", content: fnWith("big", 20, " // touched") + TINY });
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("src/a.ts:big");
	});

	it("P10: a directory-scoped run of a directory that does NOT contain the file is no signal", () => {
		ledger([BIG_ENTRY]);
		mkdirSync(join(tmp, "lib"), { recursive: true });
		const session = makeSession({ commands_run: ["npx vitest run lib/", "npx vitest run lib"] });
		const d = gate({ file_path: file, content: fnWith("big", 20, " // touched") + TINY }, session);
		expect(d?.decision).toBe("block");
	});

	it("P11: apply_patch touching a listed function with no characterization blocks the same as Edit", () => {
		ledger([BIG_ENTRY]);
		const patch =
			"*** Begin Patch\n*** Update File: src/a.ts\n@@\n-\tif (a === 0) r += 0;\n+\tif (a === 0) r += 100;\n*** End Patch";
		const d = gate({ command: patch });
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("characterize_before_touch");
		expect(d?.reason).toContain("characterize first: src/a.ts:big is a campaign target");
		// The Copilot CLI carries the same payload under `patch` instead of `command`.
		expect(gate({ patch })?.decision).toBe("block");
	});
});

describe("characterize-campaign-target — negative (must not fire)", () => {
	const TOUCH = () => ({ file_path: file, content: fnWith("big", 20, " // touched") + TINY });

	it("N1: a prior `vitest related <file>` run in the trajectory satisfies the gate", () => {
		ledger([BIG_ENTRY]);
		const session = makeSession({ commands_run: ["npx vitest related src/a.ts"] });
		expect(gate(TOUCH(), session)).toBeNull();
	});

	it("N2: a recorded per-file run of the companion test satisfies the gate", () => {
		ledger([BIG_ENTRY]);
		const session = makeSession({ test_runs: [join(tmp, "src", "a.test.ts")] });
		expect(gate(TOUCH(), session)).toBeNull();
	});

	it("N3: a companion test written this session satisfies the gate (qualified name too)", () => {
		ledger([BIG_ENTRY]);
		const plain = makeSession({ files_written: [join(tmp, "src", "a.test.ts")] });
		expect(gate(TOUCH(), plain)).toBeNull();
		const qualified = makeSession({ files_written: ["src/a.characterization.test.ts"] });
		expect(gate(TOUCH(), qualified)).toBeNull();
	});

	it("N4: editing a NON-target function in the same file passes", () => {
		ledger([BIG_ENTRY]);
		expect(gate({ file_path: file, content: BIG + fnWith("tiny", 3) })).toBeNull();
	});

	it("N5: an edit above the target that only shifts its lines is not a touch", () => {
		ledger([BIG_ENTRY]);
		expect(gate({ file_path: file, content: `// header\n${BIG}${TINY}` })).toBeNull();
	});

	it("N6: warn mode (today's default) and off mode never fire", () => {
		ledger([BIG_ENTRY]);
		expect(gate(TOUCH(), makeSession(), "warn")).toBeNull();
		expect(gate(TOUCH(), makeSession(), "off")).toBeNull();
	});

	it("N7: no ledger, or a ledger with no entry for this file, passes", () => {
		expect(gate(TOUCH())).toBeNull();
		ledger([{ file: "src/b.ts", name: "big", line: 1, value: 21 }]);
		expect(gate(TOUCH())).toBeNull();
	});

	it("N8: test files and non-JS/TS files are never gated", () => {
		ledger([{ file: "src/a.test.ts", name: "big", line: 1, value: 21 }]);
		const testFile = join(tmp, "src", "a.test.ts");
		writeFileSync(testFile, BIG);
		expect(gate({ file_path: testFile, content: fnWith("big", 20, " // x") })).toBeNull();
		expect(gate({ file_path: join(tmp, "src", "a.py"), content: "x = 1\n" })).toBeNull();
	});

	it("N11: a directory-scoped run whose directory contains the file is a signal (`src/` and bare `src`)", () => {
		ledger([BIG_ENTRY]);
		expect(gate(TOUCH(), makeSession({ commands_run: ["npx vitest run src/"] }))).toBeNull();
		expect(gate(TOUCH(), makeSession({ commands_run: ["npx vitest run src"] }))).toBeNull();
		expect(gate(TOUCH(), makeSession({ commands_run: [`npx vitest run ${join(tmp, "src")}`] }))).toBeNull();
	});

	it("N12: apply_patch to a listed function after a characterization run is allowed", () => {
		ledger([BIG_ENTRY]);
		const session = makeSession({ commands_run: ["npx vitest related src/a.ts"] });
		const patch =
			"*** Begin Patch\n*** Update File: src/a.ts\n@@\n-\tif (a === 0) r += 0;\n+\tif (a === 0) r += 100;\n*** End Patch";
		expect(gate({ command: patch }, session)).toBeNull();
	});

	it("N13: apply_patch touching only an unlisted function is not gated", () => {
		ledger([BIG_ENTRY]);
		// Distinct body from `big`'s first branch so the hunk context is unambiguous.
		const tinyDistinct = "export function tiny(a: number): number {\n\tlet r = 0;\n\tif (a === 0) r += 999;\n\treturn r;\n}\n";
		writeFileSync(file, BIG + tinyDistinct);
		const patch =
			"*** Begin Patch\n*** Update File: src/a.ts\n@@\n-\tif (a === 0) r += 999;\n+\tif (a === 0) r += 1000;\n*** End Patch";
		expect(gate({ command: patch })).toBeNull();
	});

	it("N14: a malformed apply_patch payload fails open without throwing", () => {
		ledger([BIG_ENTRY]);
		const malformed = "*** Begin Patch\n*** Update File: src/a.ts\n@@\nX bogus unknown-prefix line\n*** End Patch";
		expect(() => gate({ command: malformed })).not.toThrow();
		expect(gate({ command: malformed })).toBeNull();
	});

	it("N15: a `.`/`./` directory-scoped run resolves against event.cwd as a signal", () => {
		ledger([BIG_ENTRY]);
		expect(gate(TOUCH(), makeSession({ commands_run: ["npx vitest run ."] }))).toBeNull();
		expect(gate(TOUCH(), makeSession({ commands_run: ["npx vitest run ./"] }))).toBeNull();
	});

	it("N16: a characterization run survives 150 unrelated commands aging it out of commands_run's ring", () => {
		ledger([BIG_ENTRY]);
		const event = { hook_event: "PostToolUse", session_id: "s", timestamp: "2026-09-01T00:00:00Z" } as unknown as HarnessEvent; // SAFETY: createFreshSession reads only these fields.
		const session = createFreshSession(event, "s");
		trackCommand(
			session,
			{
				hook_event: "PostToolUse",
				session_id: "s",
				tool_name: "Bash",
				tool_input: { command: "npx vitest related src/a.ts --run" },
				timestamp: "2026-09-01T00:00:01Z",
			} as unknown as HarnessEvent, // SAFETY: trackCommand reads tool_name/tool_input.command only.
		);
		for (let i = 0; i < 150; i++) {
			trackCommand(
				session,
				{
					hook_event: "PostToolUse",
					session_id: "s",
					tool_name: "Bash",
					tool_input: { command: `echo ${i}` },
					timestamp: "2026-09-01T00:00:02Z",
				} as unknown as HarnessEvent, // SAFETY: trackCommand reads tool_name/tool_input.command only.
			);
		}
		// The ring buffer has aged the characterization command out.
		expect(session.commands_run.some((c) => c.includes("src/a.ts"))).toBe(false);
		// But the durable list still carries it, so the gate allows the edit.
		expect(gate(TOUCH(), session)).toBeNull();
	});

	it("N9: the event wrapper in warn mode stays silent for a campaign target", () => {
		ledger([BIG_ENTRY]);
		// SAFETY: the wrapper reads only structural_checks.characterize_mode.
		const rules = { structural_checks: { characterize_mode: "warn" } } as unknown as GuardRulesConfig;
		const event = {
			hook_event: "PreToolUse",
			session_id: "s",
			tool_name: "Write",
			tool_input: TOUCH(),
			cwd: tmp,
			timestamp: "2026-09-01T00:00:00Z",
		} as unknown as HarnessEvent; // SAFETY: minimal event — the wrapper reads tool_input, cwd, dry_run only.
		expect(evaluateCharacterizeForEvent(event, rules, makeSession())).toBeNull();
	});
});

describe("touchedFunctions / hasTestSignalFor — helpers", () => {
	it("P7: reports the changed and the removed function, not the untouched one", () => {
		const after = fnWith("big", 20, " // t") + fnWith("other", 2);
		const touched = touchedFunctions(BIG + TINY, after, "src/a.ts");
		expect(touched).toEqual(new Set(["big", "tiny"]));
	});

	it("N10: a test command naming an unrelated file is no signal for this one", () => {
		const session = makeSession({ commands_run: ["npx vitest run src/b.test.ts", "npm run typecheck src/a.ts"] });
		expect(hasTestSignalFor(session, file, tmp)).toBe(false);
	});
});
