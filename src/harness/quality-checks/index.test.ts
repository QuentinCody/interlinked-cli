// Smoke tests for the split quality-checks helper modules. Behavior is
// covered by src/harness/__tests__/quality-checks.test.ts; these tests just
// verify each extracted module exports the expected symbols and handles a
// representative happy-path input.

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import type { HarnessEvent, PreEditBaseline } from "../types.js";
import { resolveDependencyAuditCommand } from "./dependency-audit.js";
import { runInlineCheckBlock } from "./inline-block.js";
import { TOOL_CHECK_INSTRUCTIONS } from "./instructions.js";
import { checkLockfileDrift, LOCKFILE_MAP } from "./lockfile-drift.js";
import { checkPackageJsonConsistency } from "./package-json.js";
import { ProjectWideSweepState } from "./project-wide.js";
import { runRatchetComparison } from "./ratchet-comparison.js";
import {
	countAsAnyCasts,
	countNonNullAssertions,
	countSuppressionDirectives,
} from "./ratchet-metrics.js";
import { containsSecrets } from "./secret-detection.js";
import { findAnyTypes, stripStringLiterals } from "./strong-typing.js";
import { classifyTestFailure, isLikelyTestFile } from "./test-classifier.js";
import { runToolCheckLoop } from "./tool-check-loop.js";
import { classifyDeterminism, formatQualityWarnings } from "./warning-formatter.js";

describe("quality-checks submodules (smoke)", () => {
	it("secret-detection finds known token formats", () => {
		// Build an AWS-access-key-shaped fixture from parts — a random 16-char
		// body so it clears the entropy floor — so this test file itself
		// doesn't read as a committed secret.
		const fixture = `AKIA${"J7QX2M9FD3KP1WZ8"}`;
		expect(containsSecrets(`const k = '${fixture}'`).length).toBeGreaterThan(0);
		expect(containsSecrets("const k = 'plain'")).toEqual([]);
	});

	it("ratchet-metrics counts suppressions, `as any`, and non-null assertions", () => {
		// Build the directive fixtures from parts so this test file itself does
		// not register as containing suppression directives.
		const ts = `// @ts${"-"}ignore`;
		const es = `// eslint${"-"}disable`;
		expect(countSuppressionDirectives(`${ts}\n${es}`)).toBe(2);
		expect(countAsAnyCasts("foo as any; bar as any")).toBe(2);
		expect(countNonNullAssertions("foo!.bar; x![0]")).toBe(2);
	});

	it("strong-typing finds explicit any and strips string literals", () => {
		const matches = findAnyTypes("const x: any = 1");
		expect(matches.length).toBeGreaterThan(0);
		expect(stripStringLiterals(`const s = "hello"`)).toContain('""');
	});

	it("dependency-audit maps manifest names to commands (osv opt-out)", () => {
		// Force the legacy per-ecosystem fallback so this test doesn't depend on
		// whether osv-scanner happens to be installed on the runner.
		const opts = { useOsvScanner: false };
		expect(resolveDependencyAuditCommand("package.json", opts)?.cmd[0]).toBe("npm");
		expect(resolveDependencyAuditCommand("package.json", opts)?.parser).toBe("npm-audit");
		expect(resolveDependencyAuditCommand("Cargo.toml", opts)?.cmd[0]).toBe("cargo");
		expect(resolveDependencyAuditCommand("Cargo.toml", opts)?.parser).toBe("cargo-audit");
		expect(resolveDependencyAuditCommand("go.mod", opts)?.cmd[0]).toBe("govulncheck");
		expect(resolveDependencyAuditCommand("requirements.txt", opts)?.cmd[0]).toBe("pip-audit");
		expect(resolveDependencyAuditCommand("unknown", opts)).toBeNull();
	});

	it("lockfile-drift exports LOCKFILE_MAP keyed by manifest name", () => {
		expect(LOCKFILE_MAP["package.json"]).toContain("package-lock.json");
		const res = checkLockfileDrift("/tmp/does-not-exist-package.json");
		expect(res).toHaveProperty("drifted");
	});

	it("package-json rejects invalid semver and duplicate deps", () => {
		const issues = checkPackageJsonConsistency(
			JSON.stringify({ dependencies: { foo: "zzzz" }, devDependencies: { foo: "1.0.0" } }),
		);
		expect(issues.some((i) => i.kind === "duplicate")).toBe(true);
		expect(issues.some((i) => i.kind === "invalid_semver")).toBe(true);
	});

	it("test-classifier isLikelyTestFile recognises standard patterns", () => {
		expect(isLikelyTestFile("foo.test", "/a/foo.test.ts")).toBe(true);
		expect(isLikelyTestFile("foo", "/a/__tests__/foo.ts")).toBe(true);
		expect(isLikelyTestFile("foo", "/a/foo.ts")).toBe(false);
	});

	it("test-classifier classifies pre-existing module-resolution failures", () => {
		const out = "Error: Cannot find module './missing'\n  at ...";
		expect(classifyTestFailure("t1", out)).toBe("pre-existing");
	});

	it("project-wide sweep state increments and resets", () => {
		const st = new ProjectWideSweepState();
		st.recordEdit({ edit_interval: 2 });
		expect(st.editsSinceLastSweep).toBe(1);
		st.resetCounter();
		expect(st.editsSinceLastSweep).toBe(0);
	});

	it("instructions map has typescript entry", () => {
		expect(TOOL_CHECK_INSTRUCTIONS.typescript).toContain("Fix the type errors");
	});
});

// --- warning-formatter (classifyDeterminism + formatQualityWarnings) ---
describe("warning-formatter", () => {
	it("classifyDeterminism tags proven tools, heuristic patterns, unknown null", () => {
		expect(classifyDeterminism("typescript")).toBe("proven");
		expect(classifyDeterminism("perf_strlen_loop")).toBe("heuristic");
		expect(classifyDeterminism("totally_unregistered_check_xyz")).toBeNull();
	});

	it("formatQualityWarnings prefixes the id, tag, detail, and instruction", () => {
		const [out] = formatQualityWarnings([
			{ name: "typescript", severity: "error", message: "boom", detail: "  L1: x" },
		]);
		const lines = nonNull(out).split("\n");
		expect(lines[0]).toBe("[interlinked:typescript] [proven] boom");
		expect(lines[1]).toBe("  L1: x");
		expect(lines[2]).toMatch(/^→ /);
	});

	it("formatQualityWarnings omits the tag for unknown ids", () => {
		const [out] = formatQualityWarnings([
			{ name: "totally_unregistered_check_xyz", severity: "warning", message: "x" },
		]);
		expect(out).toBe("[interlinked:totally_unregistered_check_xyz] x");
	});
});

// --- ratchet-comparison (guard + per-metric regression warnings) ---
describe("ratchet-comparison", () => {
	const baseline = (over: Partial<PreEditBaseline> = {}): PreEditBaseline => ({
		missingReturnTypes: new Set(),
		complexFunctions: new Set(),
		capturedAt: 0,
		suppressionCount: 0,
		asAnyCastCount: 0,
		nonNullAssertionCount: 0,
		...over,
	});

	it("no-ops when diff-aware is enabled (only fires when explicitly OFF)", () => {
		const out = runRatchetComparison({
			absPath: "/a/f.ts",
			postContent: "const x = y as any; const z = w as any;",
			baseline: baseline(),
			cwd: "/a",
			diffAwareEnabled: true,
		});
		expect(out).toEqual([]);
	});

	it("no-ops when no baseline is supplied", () => {
		const out = runRatchetComparison({
			absPath: "/a/f.ts",
			postContent: "const x = y as any;",
			baseline: undefined,
			cwd: "/a",
			diffAwareEnabled: false,
		});
		expect(out).toEqual([]);
	});

	it("flags an `as any` increase against the baseline", () => {
		const out = runRatchetComparison({
			absPath: "/a/f.ts",
			postContent: "const x = y as any; const z = w as any;",
			baseline: baseline({ asAnyCastCount: 0 }),
			cwd: "/a",
			diffAwareEnabled: false,
		});
		expect(out.map((r) => r.name)).toContain("as_any_ratchet");
	});

	it("does not flag when the count holds steady", () => {
		const out = runRatchetComparison({
			absPath: "/a/f.ts",
			postContent: "const x = y as any;",
			baseline: baseline({ asAnyCastCount: 1 }),
			cwd: "/a",
			diffAwareEnabled: false,
		});
		expect(out).toEqual([]);
	});
});

// --- inline-block (generic content checks operating on a content snapshot) ---
describe("inline-block", () => {
	const event: HarnessEvent = {
		hook_event: "PostToolUse",
		session_id: "t",
		agent_source: "claude",
		tool_name: "Edit",
		timestamp: "2026-06-01T00:00:00Z",
	};

	it("flags an empty file", () => {
		const out = runInlineCheckBlock({
			event,
			filePath: "src/x.ts",
			absFilePath: "/a/src/x.ts",
			fileContent: "",
			cwd: "/a",
			diffAware: undefined,
			baseline: undefined,
			filePriority: undefined,
		});
		expect(out.some((r) => r.name === "empty_file")).toBe(true);
	});

	it("flags binary content as an error and skips other checks", () => {
		const out = runInlineCheckBlock({
			event,
			filePath: "src/x.ts",
			absFilePath: "/a/src/x.ts",
			fileContent: "abc\x00def",
			cwd: "/a",
			diffAware: undefined,
			baseline: undefined,
			filePriority: undefined,
		});
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ name: "binary_content", severity: "error" });
	});

	it("returns no findings for clean, non-empty content", () => {
		const out = runInlineCheckBlock({
			event,
			filePath: "src/x.md",
			absFilePath: "/a/src/x.md",
			fileContent: "# Title\n\nSome prose with no code issues.\n",
			cwd: "/a",
			diffAware: undefined,
			baseline: undefined,
			filePriority: undefined,
		});
		expect(out.some((r) => r.name === "binary_content" || r.name === "empty_file")).toBe(false);
	});
});

// --- tool-check-loop (config-driven per-check dispatch) ---
describe("tool-check-loop", () => {
	const baseEvent: HarnessEvent = {
		hook_event: "PostToolUse",
		session_id: "t",
		agent_source: "claude",
		tool_name: "Write",
		timestamp: "2026-06-01T00:00:00Z",
	};

	it("returns no findings when the checks map is empty", async () => {
		const out = await runToolCheckLoop({
			event: { ...baseEvent, tool_input: { file_path: "src/x.ts", content: "ok" } },
			checks: {},
			cwd: "/a",
			filePath: "src/x.ts",
			absForTestCheck: "/a/src/x.ts",
			testCheckBaseName: "x",
			getSharedContent: () => "const ok = 1;",
			getAfterRefs: () => [],
			tscFilterFile: undefined,
			baseline: undefined,
			outToolMetrics: undefined,
			editedFileInRepo: undefined,
			onCheckBoundary: undefined,
		});
		expect(out).toEqual([]);
	});

	it("runs the inline secrets_in_source branch on event content", async () => {
		const secret = `AKIA${"J7QX2M9FD3KP1WZ8"}`;
		const out = await runToolCheckLoop({
			event: {
				...baseEvent,
				tool_input: { file_path: "src/cfg.ts", content: `const k = '${secret}';` },
			},
			checks: {
				secrets_in_source: {
					enabled: true,
					file_types: [".ts"],
					timeout_ms: 1000,
					severity: "warning",
				},
			},
			cwd: "/a",
			filePath: "src/cfg.ts",
			absForTestCheck: "/a/src/cfg.ts",
			testCheckBaseName: "cfg",
			getSharedContent: () => `const k = '${secret}';`,
			getAfterRefs: () => [],
			tscFilterFile: undefined,
			baseline: undefined,
			outToolMetrics: undefined,
			editedFileInRepo: undefined,
			onCheckBoundary: undefined,
		});
		expect(out.some((r) => r.name === "secrets_in_source")).toBe(true);
	});

	it("skips a disabled check", async () => {
		const out = await runToolCheckLoop({
			event: { ...baseEvent, tool_input: { file_path: "src/x.ts", content: "x" } },
			checks: {
				secrets_in_source: {
					enabled: false,
					file_types: [".ts"],
					timeout_ms: 1000,
					severity: "warning",
				},
			},
			cwd: "/a",
			filePath: "src/x.ts",
			absForTestCheck: "/a/src/x.ts",
			testCheckBaseName: "x",
			getSharedContent: () => "x",
			getAfterRefs: () => [],
			tscFilterFile: undefined,
			baseline: undefined,
			outToolMetrics: undefined,
			editedFileInRepo: undefined,
			onCheckBoundary: undefined,
		});
		expect(out).toEqual([]);
	});
});
