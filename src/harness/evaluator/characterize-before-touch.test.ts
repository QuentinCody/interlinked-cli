import { makeGuardRules } from "./__tests__/fixtures.js";
// Tests for the characterize-before-touch gate (plan 25, lane 1).
//
// Shape mirrors tdd-new-file-gate.test.ts: build a tmpdir with an
// untested-files baseline, call the evaluator, assert the decision. No mocks —
// the gate only touches the filesystem and the session's written-file set.

import { makeSession as makeSessionFixture } from "../__tests__/fixtures/evaluator.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetUntestedFilesBaselineCache } from "../tested-file-policy.js";
import type { SessionTrajectory } from "../types.js";
import { evaluateCharacterizeBeforeTouch, evaluateCharacterizeForEvent } from "./characterize-before-touch.js";

let tmp: string;

function makeSession(writtenAbs: string[] = []): SessionTrajectory {
	// The gate reads only `files_written`; every other trajectory field is
	// irrelevant to it, matching the tdd-new-file-gate.test.ts convention.
	// SAFETY: minimal stand-in — the cast is sound because only files_written is read.
	return ({ ...makeSessionFixture(), files_written: new Set(writtenAbs) } satisfies SessionTrajectory);
}

function seedBaseline(files: string[]): void {
	mkdirSync(join(tmp, ".interlinked"), { recursive: true });
	writeFileSync(
		join(tmp, ".interlinked", "untested-files-baseline.json"),
		JSON.stringify({ version: 1, min_coverage_pct: 60, files }),
	);
}

function seedSource(rel: string, content = "export const x = 1;\n"): string {
	const abs = join(tmp, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
	return abs;
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-cbt-"));
	resetUntestedFilesBaselineCache();
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	resetUntestedFilesBaselineCache();
});

describe("characterize-before-touch — positive (must fire)", () => {
	// test-contract: behavior — editing a listed untested file without any
	// companion test must fire; block mode refuses, warn mode allows + warns
	it("P1: block mode blocks an edit to a listed file with no companion test", () => {
		seedBaseline(["src/legacy.ts"]);
		const abs = seedSource("src/legacy.ts");
		const d = evaluateCharacterizeBeforeTouch({
			filePath: abs,
			cwd: tmp,
			session: makeSession(),
			mode: "block",
		});
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("characterize_before_touch");
		expect(d?.reason).toContain("characterization test");
		expect(d?.reason).toContain("legacy.test.ts");
	});

	it("P2: warn mode allows the same edit and carries the warning", () => {
		seedBaseline(["src/legacy.ts"]);
		const abs = seedSource("src/legacy.ts");
		const d = evaluateCharacterizeBeforeTouch({
			filePath: abs,
			cwd: tmp,
			session: makeSession(),
			mode: "warn",
		});
		expect(d?.decision).toBe("allow");
		expect(d?.warnings?.[0]).toContain("[interlinked:characterize]");
		expect(d?.warnings?.[0]).toContain("untested-files");
	});

	// test-contract: behavior — `onDiskHeadHasExempt`'s catch (readFileSync
	// throwing) must NOT be read as "exempt found". A directory on disk at
	// the listed path is a real, unmocked way to make readFileSync throw
	// (EISDIR) while existsSync stays true, so this exercises the actual
	// catch branch rather than simulating it.
	it("P3: an unreadable on-disk head (EISDIR) is not treated as exempt — the gate still fires", () => {
		seedBaseline(["src/legacy.ts"]);
		const abs = join(tmp, "src", "legacy.ts");
		mkdirSync(abs, { recursive: true }); // path exists but is a DIRECTORY: readFileSync throws
		const d = evaluateCharacterizeBeforeTouch({
			filePath: abs,
			cwd: tmp,
			session: makeSession(),
			mode: "block",
		});
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain('editing untested legacy file "src/legacy.ts"');
	});
});

describe("characterize-before-touch — negative (must not fire)", () => {
	it("N1: a file NOT on the untested list passes silently", () => {
		seedBaseline(["src/other.ts"]);
		const abs = seedSource("src/legacy.ts");
		const d = evaluateCharacterizeBeforeTouch({
			filePath: abs,
			cwd: tmp,
			session: makeSession(),
			mode: "block",
		});
		expect(d).toBeNull();
	});

	it("N2: a companion test on disk satisfies the gate", () => {
		seedBaseline(["src/legacy.ts"]);
		const abs = seedSource("src/legacy.ts");
		seedSource("src/legacy.test.ts", "import './legacy.js';\n");
		const d = evaluateCharacterizeBeforeTouch({
			filePath: abs,
			cwd: tmp,
			session: makeSession(),
			mode: "block",
		});
		expect(d).toBeNull();
	});

	it("N3: a companion test written earlier this session satisfies the gate", () => {
		seedBaseline(["src/legacy.ts"]);
		const abs = seedSource("src/legacy.ts");
		const d = evaluateCharacterizeBeforeTouch({
			filePath: abs,
			cwd: tmp,
			session: makeSession([join(tmp, "src", "legacy.test.ts")]),
			mode: "block",
		});
		expect(d).toBeNull();
	});

	it("N4: mode off disables the gate entirely", () => {
		seedBaseline(["src/legacy.ts"]);
		const abs = seedSource("src/legacy.ts");
		const d = evaluateCharacterizeBeforeTouch({
			filePath: abs,
			cwd: tmp,
			session: makeSession(),
			mode: "off",
		});
		expect(d).toBeNull();
	});

	it("N5: the file-level exempt directive stands the gate down", () => {
		seedBaseline(["src/legacy.ts"]);
		const abs = seedSource(
			"src/legacy.ts",
			"// interlinked-tdd: exempt — wiring-only entry point\nexport const x = 1;\n",
		);
		const d = evaluateCharacterizeBeforeTouch({
			filePath: abs,
			cwd: tmp,
			session: makeSession(),
			mode: "block",
		});
		expect(d).toBeNull();
	});

	it("N6: test files themselves are never gated", () => {
		seedBaseline(["src/legacy.test.ts"]);
		const abs = seedSource("src/legacy.test.ts");
		const d = evaluateCharacterizeBeforeTouch({
			filePath: abs,
			cwd: tmp,
			session: makeSession(),
			mode: "block",
		});
		expect(d).toBeNull();
	});

	it("N7: a file absent from disk is the new-file TDD gate's territory, not this gate's", () => {
		seedBaseline(["src/legacy.ts"]);
		const d = evaluateCharacterizeBeforeTouch({
			filePath: join(tmp, "src", "legacy.ts"),
			cwd: tmp,
			session: makeSession(),
			mode: "block",
		});
		expect(d).toBeNull();
	});
});

describe("characterize-before-touch — Python parity (plan 25)", () => {
	// test-contract: behavior — a listed .py file gates exactly like a .ts one,
	// naming the pytest companion convention in the message
	it("P3: block mode blocks a listed .py file with no companion test", () => {
		seedBaseline(["pkg/legacy.py"]);
		const abs = seedSource("pkg/legacy.py", "def f():\n    return 1\n");
		const d = evaluateCharacterizeBeforeTouch({
			filePath: abs,
			cwd: tmp,
			session: makeSession(),
			mode: "block",
		});
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("test_legacy.py");
	});

	it("N8: a pytest companion beside the file satisfies the gate", () => {
		seedBaseline(["pkg/legacy.py"]);
		const abs = seedSource("pkg/legacy.py", "def f():\n    return 1\n");
		seedSource("pkg/test_legacy.py", "from .legacy import f\n");
		const d = evaluateCharacterizeBeforeTouch({
			filePath: abs,
			cwd: tmp,
			session: makeSession(),
			mode: "block",
		});
		expect(d).toBeNull();
	});

	it("N9: the Python exempt directive (# comment syntax) stands the gate down", () => {
		seedBaseline(["pkg/legacy.py"]);
		const abs = seedSource(
			"pkg/legacy.py",
			"# interlinked-tdd: exempt — thin __main__ wiring\nprint('x')\n",
		);
		const d = evaluateCharacterizeBeforeTouch({
			filePath: abs,
			cwd: tmp,
			session: makeSession(),
			mode: "block",
		});
		expect(d).toBeNull();
	});
});


describe("characterization event defaults", () => {
    it("blocks untested source without requiring a session trajectory", () => {
        seedBaseline(["src/legacy.ts"]);
        seedSource("src/legacy.ts");
        expect(evaluateCharacterizeBeforeTouch({ filePath: "src/legacy.ts", cwd: tmp, session: undefined, mode: "block" })?.decision).toBe("block");
    });

    it("uses the process cwd when the direct or event API receives none", () => {
        seedBaseline(["src/legacy.ts"]);
        seedSource("src/legacy.ts");
        const cwd = vi.spyOn(process, "cwd").mockReturnValue(tmp);
        try {
            expect(evaluateCharacterizeBeforeTouch({ filePath: "src/legacy.ts", session: undefined, mode: "block" })?.decision).toBe("block");
            const rules = makeGuardRules();
            delete rules.structural_checks.characterize_mode;
            expect(evaluateCharacterizeForEvent({ hook_event: "PreToolUse", agent_source: "codex", session_id: "test", timestamp: "2026-09-08", tool_input: { file_path: "src/legacy.ts" } }, rules, undefined)).toMatchObject({ decision: "allow", rule_id: "characterize_before_touch" });
            expect(evaluateCharacterizeForEvent({ hook_event: "PreToolUse", agent_source: "codex", session_id: "test", timestamp: "2026-09-08" }, rules, undefined)).toBeNull();
        } finally { cwd.mockRestore(); }
    });
});
