import { parseWire, wireNumber, wireObject } from "../../lib/value-validation.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	countCodeLines,
	countLines,
	DEFAULT_MAX_LINES,
	evaluateLargeFile,
	isCappableFile,
	isInsideRoot,
	isTestOrSpecPath,
	type LargeFileBaseline,
	loadLargeFileBaseline,
	maxLinesFor,
	resetLargeFileBaselineCache,
} from "../large-file-policy.js";

describe("DEFAULT_MAX_LINES", () => {
	it("is the canonical 500-line cap", () => {
		expect(DEFAULT_MAX_LINES).toBe(500);
	});

	// Single source of truth: the in-code default and the committed baseline's
	// max_lines MUST be the same number, so the enforced cap is never two values
	// depending on whether a baseline loaded. Ratcheting the cap means changing
	// BOTH together; this test fails the moment they drift apart.
	it("equals the committed baseline's max_lines (no drift)", () => {
		const baselinePath = join(process.cwd(), ".interlinked", "large-files-baseline.json");
		const committed = parseWire(JSON.parse(readFileSync(baselinePath, "utf-8")), wireObject({ "max_lines": wireNumber }), "test JSON value");
		expect(committed.max_lines).toBe(DEFAULT_MAX_LINES);
	});
});

describe("countLines", () => {
	it("counts newline-split segments", () => {
		expect(countLines("a\nb\nc")).toBe(3);
		expect(countLines("single")).toBe(1);
		// Trailing newline yields an empty last segment — consistent with the
		// long-standing checkLargeFile definition.
		expect(countLines("a\nb\n")).toBe(3);
	});
});

describe("countCodeLines", () => {
	it("counts pure code lines like countLines", () => {
		expect(countCodeLines("const a = 1;\nconst b = 2;")).toBe(2);
	});

	it("excludes blank and //-comment lines", () => {
		const content = ["const a = 1;", "", "// a note", "   ", "const b = 2;"].join("\n");
		expect(countCodeLines(content)).toBe(2);
		expect(countLines(content)).toBe(5);
	});

	it("excludes multi-line block-comment spans", () => {
		const content = ["/**", " * docs", " * more docs", " */", "export const x = 1;"].join("\n");
		expect(countCodeLines(content)).toBe(1);
	});

	it("counts a line with trailing comment as code, and a comment-then-code line as code", () => {
		expect(countCodeLines("doWork(); // why")).toBe(1);
		expect(countCodeLines("/* pre */ doWork();")).toBe(1);
	});

	it("treats string/template content as code — comment markers inside literals do not strip", () => {
		// A template-literal data table is the module's bulk; its lines are code.
		const content = ['const tpl = "// not a comment";', "const big = `", "  /* data line 1", "  data line 2 */", "`;"].join(
			"\n",
		);
		expect(countCodeLines(content)).toBe(5);
	});
});

describe("isTestOrSpecPath", () => {
	it("detects .test/.spec suffixes and __tests__/tests dirs", () => {
		expect(isTestOrSpecPath("src/foo.test.ts")).toBe(true);
		expect(isTestOrSpecPath("src/foo.spec.tsx")).toBe(true);
		expect(isTestOrSpecPath("src/harness/__tests__/evaluator.test.ts")).toBe(true);
		expect(isTestOrSpecPath("pkg/handler_test.go")).toBe(true);
		expect(isTestOrSpecPath("src/main/FooTest.java")).toBe(true);
	});

	// The critical regression: shared.ts::isTestFile treats interlinked-cli's
	// own harness/checks/ and harness/check-registry/ files as "test files"
	// (a content-scan FP exemption). The cap must NOT inherit that — a line
	// count is a real fact regardless of whether the file is a detector.
	it("does NOT exempt harness detector / registry source files", () => {
		expect(isTestOrSpecPath("src/harness/checks/ubs-language-specific.ts")).toBe(false);
		expect(isTestOrSpecPath("src/harness/check-registry/entries-warnings.ts")).toBe(false);
		expect(isTestOrSpecPath("src/harness/server.ts")).toBe(false);
	});
});

describe("isCappableFile", () => {
	const content = "export const x = 1;\n";

	it("flags hand-written code modules as cappable", () => {
		expect(isCappableFile({ filePath: "src/harness/server.ts", content })).toBe(true);
		expect(isCappableFile({ filePath: "src/lib/config.ts", content })).toBe(true);
		expect(
			isCappableFile({ filePath: "src/harness/checks/ubs-language-specific.ts", content }),
		).toBe(true);
	});

	it("exempts declaration, test, generated-path, and non-code files", () => {
		expect(isCappableFile({ filePath: "src/api.d.ts", content })).toBe(false);
		expect(isCappableFile({ filePath: "src/foo.test.ts", content })).toBe(false);
		expect(isCappableFile({ filePath: "src/generated/client.ts", content })).toBe(false);
		expect(isCappableFile({ filePath: "src/client.gen.ts", content })).toBe(false);
		expect(isCappableFile({ filePath: "docs/guide.md", content })).toBe(false);
		expect(isCappableFile({ filePath: "config/data.json", content })).toBe(false);
		expect(isCappableFile({ filePath: "config/data.xml", content })).toBe(false);
	});

	it("exempts vendored dependency paths but not similarly named product modules", () => {
		expect(isCappableFile({ filePath: "vendor/library/index.ts", content })).toBe(false);
		expect(isCappableFile({ filePath: "third_party/library/index.ts", content })).toBe(false);
		expect(isCappableFile({ filePath: "third-party/library/index.ts", content })).toBe(false);
		expect(isCappableFile({ filePath: "src/vendor-client.ts", content })).toBe(true);
	});

	it("exempts documentation and configuration artifacts but keeps product policy code", () => {
		expect(isCappableFile({ filePath: "docs/examples/policy.cedar", content })).toBe(false);
		expect(isCappableFile({ filePath: ".env.example", content })).toBe(false);
		expect(isCappableFile({ filePath: "evals/fixtures/pytest.ini", content })).toBe(false);
		expect(isCappableFile({ filePath: "src/policy.cedar", content })).toBe(true);
	});

	it("exempts dependency and build artifacts", () => {
		expect(isCappableFile({ filePath: "node_modules/pkg/index.ts", content })).toBe(false);
		expect(isCappableFile({ filePath: "dist/manual.ts", content })).toBe(false);
		expect(isCappableFile({ filePath: "build/generated.py", content })).toBe(false);
		expect(isCappableFile({ filePath: "go.sum", content })).toBe(false);
	});

	it("exempts tool-state and binary artifacts without hiding hidden product source", () => {
		expect(isCappableFile({ filePath: ".claude/tool.ts", content })).toBe(false);
		expect(isCappableFile({ filePath: ".codex/tool.ts", content })).toBe(false);
		expect(isCappableFile({ filePath: "assets/image.png", content })).toBe(false);
		expect(isCappableFile({ filePath: ".storybook/main.ts", content })).toBe(true);
	});

	it("exempts the repo-provisioned root scratch/ probe dir (2026-07-17)", () => {
		expect(isCappableFile({ filePath: "scratch/probe.ts", content })).toBe(false);
		expect(isCappableFile({ filePath: "scratch/sub/draft.mjs", content })).toBe(false);
		// Absolute form is exempt only when the root identifies it as ROOT-level.
		expect(isCappableFile({ filePath: "/repo/scratch/probe.ts", content, root: "/repo" })).toBe(
			false,
		);
		// A nested scratch/ is somebody's product module — still cappable.
		expect(isCappableFile({ filePath: "src/scratch/module.ts", content })).toBe(true);
		// Similar-prefix dirs never match (prefix must be the scratch/ segment).
		expect(isCappableFile({ filePath: "scratchpad/x.ts", content })).toBe(true);
	});

	it("exempts HTML/markup documents — length measures content, not module complexity", () => {
		const html = "<!doctype html>\n<html><body><h1>report</h1></body></html>\n";
		expect(isCappableFile({ filePath: "site/index.html", content: html })).toBe(false);
		expect(isCappableFile({ filePath: "pages/legacy.htm", content: html })).toBe(false);
		expect(isCappableFile({ filePath: "reports/monograph.xhtml", content: html })).toBe(false);
		// Guard the boundary: a .ts module that RENDERS html is still code.
		expect(isCappableFile({ filePath: "src/render-html.ts", content })).toBe(true);
		// .shtml is not in the skip list (extension must match exactly).
		expect(isCappableFile({ filePath: "site/includes.shtml", content: html })).toBe(true);
	});

	it("exempts files carrying a generated-content marker", () => {
		const generated = "// @generated SignedSource<<abc123>>\nexport const x = 1;\n";
		expect(isCappableFile({ filePath: "src/schema.ts", content: generated })).toBe(false);
	});

	it("exempts files carrying a @codegen-data header marker", () => {
		// Codegen-DATA modules (large template strings emitted verbatim into
		// generated output) are exempt from the line cap — scoped to the cap
		// only, NOT a full @generated exemption (tsc/lint still run).
		const codegenData =
			"// foo-template.ts @codegen-data: template DATA, cap-exempt\nexport const X = `...`;\n";
		expect(
			isCappableFile({ filePath: "src/lib/foo-template.ts", content: codegenData }),
		).toBe(false);
		// Bounded scan: a marker buried past the 20-line header does NOT exempt.
		const buried = `${"// pad\n".repeat(25)}// @codegen-data\nexport const X = 1;\n`;
		expect(isCappableFile({ filePath: "src/lib/bar.ts", content: buried })).toBe(true);
	});

	it("exempts the harness's own .interlinked/ state dir and diff/patch artifacts", () => {
		// .interlinked/ is tool state (logs, trigram index, archives, e2e probes,
		// workflow scratch) — never a product module, so a count there is moot.
		expect(isCappableFile({ filePath: ".interlinked/e2e-stability.mjs", content })).toBe(false);
		expect(isCappableFile({ filePath: "sub/.interlinked/probe.ts", content })).toBe(false);
		expect(
			isCappableFile({ filePath: ".interlinked/merge-patches/item-4.diff", content }),
		).toBe(false);
		expect(isCappableFile({ filePath: "patches/fix.patch", content })).toBe(false);
		// A non-dot "interlinked" directory is ordinary source — still cappable.
		expect(isCappableFile({ filePath: "src/interlinked/feature.ts", content })).toBe(true);
	});
});

describe("isCappableFile — root confinement", () => {
	// The cap is the guarded repo's maintainability policy; a file outside the
	// root is not governed by it. Observed live 2026-07-15: a 586-line
	// self-contained HTML artifact in the session scratchpad was blocked by
	// the repo's 500-line cap (and the block steered the agent toward
	// compressing formatting to duck under it — gate-induced metric gaming).
	const content = "export const x = 1;\n";
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "interlinked-lfp-root-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("exempts files outside the guarded root (session scratchpad artifact shape)", () => {
		const scratchpad = mkdtempSync(join(tmpdir(), "claude-501-scratchpad-"));
		try {
			const artifact = join(scratchpad, "pcos-monograph.html");
			expect(isCappableFile({ filePath: artifact, content, root })).toBe(false);
			expect(isCappableFile({ filePath: join(scratchpad, "probe.ts"), content, root })).toBe(
				false,
			);
		} finally {
			rmSync(scratchpad, { recursive: true, force: true });
		}
	});

	it("keeps in-root code cappable — absolute, relative, and not-yet-created paths", () => {
		expect(isCappableFile({ filePath: join(root, "src", "mod.ts"), content, root })).toBe(true);
		expect(isCappableFile({ filePath: "src/mod.ts", content, root })).toBe(true);
		// Brand-new nested path (nothing on disk yet): the nearest-existing-
		// ancestor realpath walk must still judge it inside.
		expect(
			isCappableFile({ filePath: join(root, "brand", "new", "mod.ts"), content, root }),
		).toBe(true);
	});

	it("rejects ../ traversal that lexically starts with the root", () => {
		expect(
			isCappableFile({ filePath: join(root, "..", "outside", "mod.ts"), content, root }),
		).toBe(false);
		expect(isCappableFile({ filePath: "../outside/mod.ts", content, root })).toBe(false);
	});

	it("normalizes symlinked prefixes on either side (macOS /tmp → /private/tmp)", () => {
		const real = join(root, "real");
		mkdirSync(real, { recursive: true });
		writeFileSync(join(real, "mod.ts"), content);
		const link = join(root, "link");
		symlinkSync(real, link);
		// Root given via the SYMLINK, file via the REAL path — and vice versa.
		expect(isCappableFile({ filePath: join(real, "mod.ts"), content, root: link })).toBe(true);
		expect(isCappableFile({ filePath: join(link, "mod.ts"), content, root: real })).toBe(true);
		// A brand-new (not-on-disk) file under the symlinked root still matches.
		expect(isCappableFile({ filePath: join(link, "new.ts"), content, root: real })).toBe(true);
	});

	it("without a root, location is not consulted (legacy repo-walk callers)", () => {
		expect(isCappableFile({ filePath: "/anywhere/at/all/mod.ts", content })).toBe(true);
	});

	it("isInsideRoot treats the root itself as inside and siblings as outside", () => {
		expect(isInsideRoot(root, root)).toBe(true);
		expect(isInsideRoot(root, `${root}-sibling/mod.ts`)).toBe(false);
	});

	it("stays stack- and latency-safe on pathologically deep paths (deep-round #9)", () => {
		// Well within the cap: resolves normally.
		const shallow = `${root}/${"a/".repeat(50)}x.ts`;
		expect(isInsideRoot(root, shallow)).toBe(true);
		// Absurdly deep: must not throw and must return fast (the walk is
		// bounded, so this is milliseconds, not the ~90s an unbounded walk took).
		const deep = `${root}/${"a/".repeat(20000)}x.ts`;
		const start = Date.now();
		expect(() => isInsideRoot(root, deep)).not.toThrow();
		expect(Date.now() - start).toBeLessThan(2000);
		// Over-cap fails CLOSED — treated as outside the root (safe direction),
		// even for a path that lexically sits under the root (round-2 #34).
		expect(isInsideRoot(root, deep)).toBe(false);
		expect(isInsideRoot(root, `${root}/${"a/".repeat(300)}x.ts`)).toBe(false);
	});
});

describe("evaluateLargeFile", () => {
	const baseline: LargeFileBaseline = {
		version: 1,
		max_lines: 1500,
		files: { "src/harness/server.ts": 3747 },
	};

	it("passes files at or under the cap", () => {
		const verdict = evaluateLargeFile({ relPath: "src/small.ts", lines: 1500, baseline });
		expect(verdict.overCap).toBe(false);
		expect(verdict.grandfathered).toBe(false);
	});

	it("fails a non-baselined file over the cap", () => {
		const verdict = evaluateLargeFile({ relPath: "src/new-big.ts", lines: 1800, baseline });
		expect(verdict.overCap).toBe(true);
		expect(verdict.grandfathered).toBe(false);
	});

	it("grandfathers a baselined file within its recorded ceiling", () => {
		const verdict = evaluateLargeFile({
			relPath: "src/harness/server.ts",
			lines: 3700,
			baseline,
		});
		expect(verdict.overCap).toBe(true);
		expect(verdict.grandfathered).toBe(true);
		expect(verdict.ceiling).toBe(3747);
	});

	it("fails a baselined file that grew past its recorded ceiling", () => {
		const verdict = evaluateLargeFile({
			relPath: "src/harness/server.ts",
			lines: 3800,
			baseline,
		});
		expect(verdict.overCap).toBe(true);
		expect(verdict.grandfathered).toBe(false); // ratchet violated by growth
	});

	// Pins the comment-only-growth interaction (field report 2026-07-06): the
	// recorded grandfather ceiling tracks RAW lines and is never raised, even
	// though the PreToolUse gate now allows comment-only growth past it. A
	// grandfathered file whose raw count exceeds its ceiling — comments or not —
	// reads as not-grandfathered here, so sustained comment growth surfaces in
	// verify's large_files check. Remedy: decompose the file; never raise the
	// ceiling (the baseline-integrity gate blocks raises anyway).
	it("judges the grandfather ceiling on RAW lines even when growth was comment-only", () => {
		const verdict = evaluateLargeFile({
			relPath: "src/harness/server.ts",
			lines: 3747 + 3, // e.g. three doc-comment lines past the recorded ceiling
			baseline,
		});
		expect(verdict.overCap).toBe(true);
		expect(verdict.grandfathered).toBe(false);
		expect(verdict.ceiling).toBe(3747); // the ceiling itself did not move
	});

	it("treats a shrunk-under-cap baselined file as simply passing", () => {
		const verdict = evaluateLargeFile({
			relPath: "src/harness/server.ts",
			lines: 900,
			baseline,
		});
		expect(verdict.overCap).toBe(false);
		expect(verdict.grandfathered).toBe(false);
	});

	it("falls back to DEFAULT_MAX_LINES when no baseline is loaded", () => {
		const verdict = evaluateLargeFile({ relPath: "src/x.ts", lines: 1501, baseline: null });
		expect(verdict.overCap).toBe(true);
	});

	it("honors an explicit maxLines override below the baseline cap (verify path)", () => {
		// baseline cap is 1500, but a repo that ran `interlinked caps set lines 300`
		// resolves to 300 — a 400-line file is over the EFFECTIVE cap. verify must
		// pass that resolved cap, not the baseline (finding 2026-06, round 8).
		const verdict = evaluateLargeFile({ relPath: "src/x.ts", lines: 400, baseline, maxLines: 300 });
		expect(verdict.overCap).toBe(true);
	});

	it("honors a RAISED maxLines override (a file the baseline would flag passes)", () => {
		const verdict = evaluateLargeFile({ relPath: "src/x.ts", lines: 1600, baseline, maxLines: 2000 });
		expect(verdict.overCap).toBe(false);
	});
});

describe("loadLargeFileBaseline + maxLinesFor", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lfp-"));
		resetLargeFileBaselineCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		resetLargeFileBaselineCache();
	});

	it("returns null + the default cap when no baseline file exists", () => {
		expect(loadLargeFileBaseline(dir)).toBeNull();
		expect(maxLinesFor(dir)).toBe(DEFAULT_MAX_LINES);
	});

	it("loads max_lines and the grandfather map", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "large-files-baseline.json"),
			JSON.stringify({ version: 1, max_lines: 1200, files: { "src/big.ts": 2000 } }),
		);
		resetLargeFileBaselineCache();
		const baseline = loadLargeFileBaseline(dir);
		expect(baseline?.max_lines).toBe(1200);
		expect(baseline?.files["src/big.ts"]).toBe(2000);
		expect(maxLinesFor(dir)).toBe(1200);
	});

	it("fails soft to the default cap on malformed JSON", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "large-files-baseline.json"), "{ not json");
		resetLargeFileBaselineCache();
		expect(loadLargeFileBaseline(dir)).toBeNull();
		expect(maxLinesFor(dir)).toBe(DEFAULT_MAX_LINES);
	});

	it("metric-caps.json max_lines override beats the baseline (interlinked caps set lines)", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "large-files-baseline.json"),
			JSON.stringify({ version: 1, max_lines: 1200, files: {} }),
		);
		writeFileSync(
			join(dir, ".interlinked", "metric-caps.json"),
			JSON.stringify({ version: 1, max_lines: 222 }),
		);
		resetLargeFileBaselineCache();
		// maxLinesFor layers metric-caps.json (the unified caps surface) OVER the
		// large-files baseline; verify resolves through this, so a lowered cap is no
		// longer silently ignored there (finding 2026-06, round 8).
		expect(maxLinesFor(dir)).toBe(222);
	});
});
