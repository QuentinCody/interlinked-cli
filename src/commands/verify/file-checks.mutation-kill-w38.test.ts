// ===========================================
// file-checks.ts — wave-38 mutation-kill suite
// ===========================================
// Targets the survivor set in
// scratch/fleet-r3/w38-briefs/src_commands_verify_file-checks.ts.json.
// Companion to file-checks.test.ts — kept separate per fleet convention.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_LINES } from "../../harness/large-file-policy.js";
import { resetUntestedFilesBaselineCache } from "../../harness/tested-file-policy.js";
import { nonNull } from "../../lib/non-null.js";
import type { MetricsCoverage } from "../metrics-coverage.js";
import { resetUntestedCoverageCache, runPerFileChecks } from "./file-checks.js";
import { type CodeQualityResults, emptyResults } from "./tool-results-types.js";

const { loadMetricsCoverageMock } = vi.hoisted(() => ({
	loadMetricsCoverageMock: vi.fn(),
}));

// The per-file battery calls `coverageFor(cwd)` unconditionally (via
// `collectUntestedFileFinding`) on every non-.d.ts/.json file, so every test
// in this file needs a safe default return — see the top-level beforeEach.
vi.mock("../metrics-coverage.js", () => ({
	loadMetricsCoverage: loadMetricsCoverageMock,
}));

beforeEach(() => {
	vi.clearAllMocks();
	resetUntestedCoverageCache();
	loadMetricsCoverageMock.mockReturnValue({
		linePct: () => null,
	} as unknown as MetricsCoverage);
});

function run(file: string, content: string, cwd = "/tmp"): CodeQualityResults {
	const r = emptyResults();
	runPerFileChecks({
		file,
		content,
		cwd,
		r,
		moduleExportsCache: new Map(),
		allEnvRefs: new Map(),
		piiOpts: {},
	});
	return r;
}

describe("collectMockDriftFindings — !resolved guard (63968e95e863b886)", () => {
	// test-contract: public-api — runPerFileChecks must not report mock drift
	// for a mock whose module path never resolves, regardless of what an
	// unrelated cache entry happens to hold.
	it("does not follow through when the mock's module path fails to resolve, even with a matching null-keyed cache entry", () => {
		// Module path never resolves -> `resolved` is null. A correct `!resolved`
		// guard continues immediately. If the guard is defeated, the mutant
		// proceeds to `moduleExportsCache.get(resolved)` with a null key, and
		// then to `relative(cwd, resolved)` with a null "to" argument, which
		// node:path throws on — killing the mutant via an uncaught exception.
		const cache = new Map<string, string[]>();
		cache.set(null as unknown as string, ["something-else"]);
		const content = 'vi.mock("./absolutely-does-not-exist-w38.js", () => ({ ghost: vi.fn() }));\n';
		const r = emptyResults();
		expect(() =>
			runPerFileChecks({
				file: "/tmp/subject.test.ts",
				content,
				cwd: "/tmp",
				r,
				moduleExportsCache: cache,
				allEnvRefs: new Map(),
				piiOpts: {},
			}),
		).not.toThrow();
		expect(r.mockDrift).toHaveLength(0);
	});
});

describe("runPerFileChecks — before-map / start snapshot (b9e2d1cffc4e5e17, ee390d2a07d20dcd)", () => {
	// test-contract: invariant — the inline-ignore drop pass must only ever
	// re-examine findings THIS file contributed; a pre-existing bucket entry
	// from an earlier file must survive untouched.
	it("preserves a pre-existing bucket entry when the inline-ignore drop pass runs (start must reflect the true pre-run length)", () => {
		// If the `before` snapshot (or its later `start` read) collapses a
		// nonzero pre-existing bucket length to 0, `dropInlineSuppressed` will
		// slice from index 0 instead of index 1 and re-examine (and drop) the
		// pre-existing entry too, since it shares the same (line, check) as the
		// inline-ignore target.
		const r = emptyResults();
		r.consoleStatements.push({
			check: "console_statements",
			file: "other.ts",
			line: 2,
			message: "pre-existing",
		});
		const content = [
			"// interlinked-ignore: console_statements — testing",
			"console.log('new');",
			"",
		].join("\n");
		runPerFileChecks({
			file: "/tmp/w38-before.ts",
			content,
			cwd: "/tmp",
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		expect(r.consoleStatements).toHaveLength(1);
		expect(nonNull(r.consoleStatements[0]).message).toBe("pre-existing");
	});
});

// NOTE (wave-38 cleanup): a "dropInlineSuppressed — undefined-bucket guard"
// case previously lived here, asserting that omitting a bucket key from the
// results fixture reaches dropInlineSuppressed's `if (!bucket ...)` guard
// without crashing. That premise is false: `collectPerFileFindings` (called
// unconditionally, before dropInlineSuppressed, at file-checks.ts:144)
// unconditionally does `r.<bucket>.push(...)` for every bucket key regardless
// of whether the content matched anything — so omitting ANY bucket crashes at
// that earlier, unconditional push, never reaching dropInlineSuppressed's
// guard at all. dropInlineSuppressed is also unexported, so its guard can't
// be exercised directly without a source change (out of scope here). Deleted
// as a genuinely-wrong assertion rather than patched.

describe("dropInlineSuppressed — slice(start) vs whole-bucket filter (5277f790e7faa4a8)", () => {
	// test-contract: invariant — the drop pass re-filters only the tail this
	// file added; an unrelated earlier bucket entry must appear exactly once
	// in the output, never duplicated.
	it("only re-filters the tail added by this file, never re-examining an earlier unrelated entry", () => {
		const r = emptyResults();
		r.consoleStatements.push({
			check: "console_statements",
			file: "other.ts",
			line: 99,
			message: "pre-existing-unrelated",
		});
		const content = [
			"// interlinked-ignore: silent_catches — reason",
			"try { foo(); } catch (e) {}",
			"console.log('new');",
			"",
		].join("\n");
		runPerFileChecks({
			file: "/tmp/w38-slice.ts",
			content,
			cwd: "/tmp",
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		// Correct: [pre-existing, new]. If `.slice(start)` is replaced by the
		// whole bucket, the pre-existing entry is both retained by the
		// truncate-then-push logic AND re-pushed via the unsliced filter,
		// duplicating it (length 3 instead of 2).
		expect(r.consoleStatements).toHaveLength(2);
		expect(r.consoleStatements.map((c) => c.message)).toEqual([
			"pre-existing-unrelated",
			expect.stringContaining("console.log"),
		]);
	});
});

describe("collectLargeFileFinding — message text (cf3d0c9bd9128a99)", () => {
	// test-contract: public-api — the large_files advisory message must name
	// the line count and the cap, not an empty string.
	it("includes the line count and cap in the large_files message", () => {
		const overCap = Array.from({ length: DEFAULT_MAX_LINES + 600 }, () => "const x = 1;").join("\n");
		const r = run("/tmp/w38-huge.ts", overCap);
		expect(r.largeFiles).toHaveLength(1);
		const msg = nonNull(r.largeFiles[0]).message;
		expect(msg).toContain("lines — over the");
		expect(msg).toContain("-line cap for hand-written code. Split into smaller, focused modules.");
	});
});

describe("coverageFor — per-cwd cache reuse (bca4702eb1524ab9)", () => {
	// test-contract: invariant — the coverage accessor is memoized per cwd; a
	// second file checked in the same cwd must reuse it rather than reload.
	it("loads coverage once per cwd and reuses the cached accessor for a second file in the same cwd, and both files still get a coverage verdict", () => {
		const r1 = run(
			"/tmp/w38cov/a.ts",
			"export function f(n: number): number {\n\treturn n;\n}\n",
			"/tmp/w38cov",
		);
		const r2 = run(
			"/tmp/w38cov/b.ts",
			"export function g(n: number): number {\n\treturn n;\n}\n",
			"/tmp/w38cov",
		);
		expect(loadMetricsCoverageMock).toHaveBeenCalledTimes(1);
		// Both files still reach a real (mocked-null-coverage) untested verdict —
		// the cache reuse must not have silently skipped the check.
		expect(r1.untestedFiles).toHaveLength(1);
		expect(r2.untestedFiles).toHaveLength(1);
	});
});

describe("resetUntestedCoverageCache — clears the memo (34b636b115896edc)", () => {
	// test-contract: public-api — the exported reset function must actually
	// clear the per-cwd memo so the next lookup reloads.
	it("forces a reload on the next call after a reset", () => {
		const r1 = run(
			"/tmp/w38cov2/a.ts",
			"export function f(n: number): number {\n\treturn n;\n}\n",
			"/tmp/w38cov2",
		);
		expect(loadMetricsCoverageMock).toHaveBeenCalledTimes(1);
		resetUntestedCoverageCache();
		const r2 = run(
			"/tmp/w38cov2/b.ts",
			"export function g(n: number): number {\n\treturn n;\n}\n",
			"/tmp/w38cov2",
		);
		expect(loadMetricsCoverageMock).toHaveBeenCalledTimes(2);
		expect(r1.untestedFiles).toHaveLength(1);
		expect(r2.untestedFiles).toHaveLength(1);
	});
});

describe("collectUntestedFileFinding — backslash normalization before baseline lookup (1012d14ceece061f)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-fc-w38-slash-"));
		mkdirSync(join(dir, "src"), { recursive: true });
		resetUntestedFilesBaselineCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		resetUntestedFilesBaselineCache();
	});

	// test-contract: public-api — a relPath containing a literal backslash
	// must be normalized to '/' before the grandfather-list lookup, per the
	// documented baseline-matching contract in tested-file-policy.ts.
	it("normalizes a backslash to '/' (not '') so the grandfather-list lookup matches", () => {
		const abs = join(dir, "src", "weird\\name.ts");
		const content = "export function f(n: number): number {\n\tif (n > 0) return n;\n\treturn 0;\n}\n";
		writeFileSync(abs, content);
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "untested-files-baseline.json"),
			JSON.stringify({ version: 1, min_coverage_pct: 60, files: ["src/weird/name.ts"] }),
		);
		resetUntestedFilesBaselineCache();
		const r = run(abs, content, dir);
		// If the mutant strips the backslash to "" instead of converting it to
		// "/", the relPath used for the baseline lookup no longer matches the
		// recorded grandfather entry, and the file wrongly surfaces as untested.
		expect(r.untestedFiles).toHaveLength(0);
	});
});

describe("collectUntestedFileFinding — message text (70becb6d8ea336a1, 0c23f9f4c6c4176c)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-fc-w38-untested-msg-"));
		mkdirSync(join(dir, "src"), { recursive: true });
		resetUntestedFilesBaselineCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		resetUntestedFilesBaselineCache();
	});

	// test-contract: public-api — the untested_files advisory message names
	// both halves of the concatenated string, not an empty fragment.
	it("carries the full advisory message on an untested-file finding", () => {
		const abs = join(dir, "src", "lonely-w38.ts");
		const content = "export function f(n: number): number {\n\tif (n > 0) return n;\n\treturn 0;\n}\n";
		writeFileSync(abs, content);
		const r = run(abs, content, dir);
		expect(r.untestedFiles).toHaveLength(1);
		const msg = nonNull(r.untestedFiles[0]).message;
		expect(msg).toContain("no companion test and line coverage below threshold — add a sibling ");
		expect(msg).toContain("*.test file or cover it from an existing suite.");
	});
});

describe("collectJsonFindings — finding shape and check name (978d312020c7adf4, f420ec69afee38e3)", () => {
	// test-contract: public-api — an invalid-JSON finding must be a fully
	// populated CodeQualityIssue, not an empty object.
	it("pushes a fully-populated json_validity finding for invalid JSON", () => {
		const r = run("/tmp/w38-bad.json", "{not json");
		expect(r.jsonValidity).toHaveLength(1);
		const finding = nonNull(r.jsonValidity[0]);
		expect(finding.check).toBe("json_validity");
		expect(finding.file).toBe("w38-bad.json");
		expect(finding.line).toBe(0);
		expect(finding.message.length).toBeGreaterThan(0);
	});
});

describe("collectJsonFindings — error message slicing (47d055bfbc5631cb)", () => {
	// test-contract: boundary — an overlong JSON.parse error message must be
	// truncated to the documented JSON_PARSE_ERR_SLICE (150 chars) cap.
	it("slices an overlong JSON.parse error message to the configured cap", () => {
		const longMessage = "x".repeat(300);
		const spy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
			throw new Error(longMessage);
		});
		try {
			const r = run("/tmp/w38-longerr.json", "{not json either");
			expect(r.jsonValidity).toHaveLength(1);
			expect(nonNull(r.jsonValidity[0]).message).toHaveLength(150);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("collectJsonFindings — tsconfig_strictness check name (20ddab13350ddda4)", () => {
	// test-contract: public-api — a tsconfig strictness gap must be reported
	// under the "tsconfig_strictness" check id.
	it("tags a tsconfig strictness finding with the correct check id", () => {
		const r = run("/tmp/tsconfig.json", '{"compilerOptions": {}}');
		expect(r.tsconfigStrictness.length).toBeGreaterThan(0);
		expect(nonNull(r.tsconfigStrictness[0]).check).toBe("tsconfig_strictness");
	});
});

describe("collectStrongTypingFindings — .tsx must not be excluded (cff7db8c6d6d00b1, 06c13d713e55456f)", () => {
	// test-contract: public-api — the every-file-tested-equivalent
	// strong-typing check must run on .tsx sources, mirroring .ts.
	it("runs strong_typing on a .tsx file", () => {
		const r = run("/tmp/w38-comp.tsx", "export const a: any = 1;\n");
		expect(r.strongTyping).toHaveLength(1);
		expect(nonNull(r.strongTyping[0]).check).toBe("strong_typing");
	});
});

describe("collectPerFileFindings — console_statements / silent_catches check names (e829d5c0bea1b9dc, 2bd8e3df397a63b7)", () => {
	// test-contract: public-api — a console.log call is reported under the
	// "console_statements" check id.
	it("tags a console statement finding with the correct check id", () => {
		const r = run("/tmp/w38-console.ts", "console.log('hi');\n");
		expect(r.consoleStatements.length).toBeGreaterThan(0);
		expect(nonNull(r.consoleStatements[0]).check).toBe("console_statements");
	});

	// test-contract: public-api — an empty catch block is reported under the
	// "silent_catches" check id.
	it("tags a silent-catch finding with the correct check id", () => {
		const r = run("/tmp/w38-silent.ts", "try { foo(); } catch (e) {}\n");
		expect(r.silentCatches.length).toBeGreaterThan(0);
		expect(nonNull(r.silentCatches[0]).check).toBe("silent_catches");
	});
});

describe("collectPerFileFindings — suppression-collection gate (dfb1291f47244711, 2522d1fad258b098, 0976c9e78c8399b0, 319f52fc4256a70b, c29230691ed8a979)", () => {
	// test-contract: public-api — a suppression comment in a non-generated
	// JS/TS file must be collected into r.suppressions.
	it("collects a suppression finding for a JS/TS, non-generated file", () => {
		const marker = ["//", " @ts-ignore"].join("");
		const r = run("/tmp/w38-supp-a.ts", `${marker}\nconst x = 1;\n`);
		expect(r.suppressions).toHaveLength(1);
	});

	// test-contract: boundary — the collector is gated on JS_TS_EXTS; a
	// non-JS/TS extension must produce no suppression findings even when the
	// content contains the same marker text.
	it("does not collect a suppression finding for a non-JS/TS extension", () => {
		const marker = ["//", " @ts-ignore"].join("");
		const r = run("/tmp/w38-supp-b.py", `${marker}\nx = 1\n`);
		expect(r.suppressions).toHaveLength(0);
	});
});

describe("collectPerFileFindings — phantom-import gate on JS_TS_EXTS (d48597a39dfcd198)", () => {
	// test-contract: boundary — phantom-import detection is gated on
	// JS_TS_EXTS; a non-JS/TS extension must be skipped even with JS import
	// syntax in its content.
	it("does not collect phantom imports for a non-JS/TS extension, even with JS import syntax", () => {
		const r = run(
			"/tmp/interlinked-fc-w38-phantom-py/x.py",
			'import { y } from "./definitely-missing-w38.js";\n',
		);
		expect(r.phantomImports).toHaveLength(0);
	});
});

describe("collectPerFileFindings — missing_return_types / no_test_file / complexity check names (35ea41ff091e46a5, b6b46a505d2a6180, 23ab67572715018b)", () => {
	// test-contract: public-api — an exported function with no return-type
	// annotation is reported under "missing_return_types".
	it("tags a missing-return-type finding with the correct check id", () => {
		const r = run("/tmp/w38-noret.ts", "export function f(x) {\n\treturn x;\n}\n");
		expect(r.missingReturnTypes.length).toBeGreaterThan(0);
		expect(nonNull(r.missingReturnTypes[0]).check).toBe("missing_return_types");
	});

	// test-contract: public-api — a source file with no companion test on
	// disk is reported under "no_test_file".
	it("tags a no-companion-test finding with the correct check id", () => {
		const dir = mkdtempSync(join(tmpdir(), "interlinked-fc-w38-notest-"));
		try {
			const abs = join(dir, "lonely-w38.ts");
			const content = "export function f(n: number): number {\n\tif (n > 0) return n;\n\treturn 0;\n}\n";
			writeFileSync(abs, content);
			const r = run(abs, content, dir);
			expect(r.noTestFile.length).toBeGreaterThan(0);
			expect(nonNull(r.noTestFile[0]).check).toBe("no_test_file");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// test-contract: public-api — a function with many branches is reported
	// under "complexity".
	it("tags a function-complexity finding with the correct check id", () => {
		const branches = Array.from({ length: 20 }, (_, i) => `\tif (n === ${i}) return ${i};`).join("\n");
		const content = `export function complexW38(n: number): number {\n${branches}\n\treturn -1;\n}\n`;
		const r = run("/tmp/w38-complex.ts", content);
		expect(r.complexity.length).toBeGreaterThan(0);
		expect(nonNull(r.complexity[0]).check).toBe("complexity");
	});
});
