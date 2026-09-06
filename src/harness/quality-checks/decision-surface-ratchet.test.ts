import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionSurfaceReport, DetectDecisionSurfaceOptions } from "./decision-surface.js";
import type { DecisionSurfaceCategory } from "./decision-surface-map.js";
import {
	computeDecisionSurfaceRatchet,
	diffDecisionSurface,
	makeGitBackedOptions,
} from "./decision-surface-ratchet.js";

// Toggle to make the baseline `detectDecisionSurface(cwd, options)` call throw
// (options defined) while the plain `detectDecisionSurface(cwd)` call used for
// "current" (options undefined) still runs for real — covers the git-error
// catch around the baseline read, distinct from the ordinary skip reasons
// ("not-a-repo" / "no-baseline-ref") which never reach that call at all.
const forceBaselineDetectError = vi.hoisted(() => ({ value: false }));
vi.mock("./decision-surface.js", async () => {
	const actual = await vi.importActual<typeof import("./decision-surface.js")>("./decision-surface.js");
	return {
		...actual,
		detectDecisionSurface: (cwd: string, options?: DetectDecisionSurfaceOptions) => {
			if (options !== undefined && forceBaselineDetectError.value) {
				throw new Error("git show returned unparseable ref content");
			}
			return actual.detectDecisionSurface(cwd, options);
		},
	};
});

// ===========================================
// Fixture helpers
// ===========================================

function makeReport(byCategory: Partial<Record<DecisionSurfaceCategory, string[]>>): DecisionSurfaceReport {
	const filled: Record<DecisionSurfaceCategory, string[]> = {
		package_manager: byCategory.package_manager ?? [],
		test_framework: byCategory.test_framework ?? [],
		linter: byCategory.linter ?? [],
		formatter: byCategory.formatter ?? [],
		bundler: byCategory.bundler ?? [],
		http_client: byCategory.http_client ?? [],
		date_lib: byCategory.date_lib ?? [],
	};
	const total = Object.values(filled).reduce((sum, arr) => sum + arr.length, 0);
	return { byCategory: filled, totalSurface: total, projectRoot: "/repo" };
}

// ===========================================
// diffDecisionSurface — pure
// ===========================================

describe("diffDecisionSurface — pure diff semantics", () => {
	it("reports no growth when baseline equals current", () => {
		const baseline = makeReport({ test_framework: ["vitest"] });
		const current = makeReport({ test_framework: ["vitest"] });
		const result = diffDecisionSurface(baseline, current, "origin/main");
		expect(result.totalGrowth).toBe(0);
		expect(result.warnings).toEqual([]);
		expect(result.growthByCategory.test_framework).toEqual([]);
	});

	it("reports growth when a new test framework is added", () => {
		const baseline = makeReport({ test_framework: ["vitest"] });
		const current = makeReport({ test_framework: ["jest", "vitest"] });
		const result = diffDecisionSurface(baseline, current, "origin/main");
		expect(result.growthByCategory.test_framework).toEqual(["jest"]);
		expect(result.totalGrowth).toBe(1);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toMatch(/test_framework/);
		expect(result.warnings[0]).toMatch(/jest/);
		expect(result.warnings[0]).toMatch(/origin\/main/);
	});

	it("reports growth across multiple categories", () => {
		const baseline = makeReport({});
		const current = makeReport({
			test_framework: ["vitest"],
			linter: ["biome"],
			bundler: ["tsup"],
		});
		const result = diffDecisionSurface(baseline, current, "origin/main");
		expect(result.totalGrowth).toBe(3);
		expect(result.warnings).toHaveLength(3);
		expect(result.growthByCategory.test_framework).toEqual(["vitest"]);
		expect(result.growthByCategory.linter).toEqual(["biome"]);
		expect(result.growthByCategory.bundler).toEqual(["tsup"]);
	});

	it("is silent on shrinkage (tool removed)", () => {
		const baseline = makeReport({ test_framework: ["jest", "vitest"] });
		const current = makeReport({ test_framework: ["vitest"] });
		const result = diffDecisionSurface(baseline, current, "origin/main");
		expect(result.totalGrowth).toBe(0);
		expect(result.warnings).toEqual([]);
	});

	it("does NOT report a tool that exists in both (no churn)", () => {
		const baseline = makeReport({ test_framework: ["jest", "vitest"] });
		const current = makeReport({ test_framework: ["jest", "vitest"] });
		const result = diffDecisionSurface(baseline, current, "origin/main");
		expect(result.totalGrowth).toBe(0);
	});

	it("reports both growth and shrinkage as growth-only (substitution)", () => {
		// jest removed, mocha added — only mocha shows up as growth
		const baseline = makeReport({ test_framework: ["jest", "vitest"] });
		const current = makeReport({ test_framework: ["mocha", "vitest"] });
		const result = diffDecisionSurface(baseline, current, "origin/main");
		expect(result.growthByCategory.test_framework).toEqual(["mocha"]);
		expect(result.totalGrowth).toBe(1);
	});

	it("includes the baseline ref in each warning line", () => {
		const baseline = makeReport({});
		const current = makeReport({ http_client: ["axios"] });
		const result = diffDecisionSurface(baseline, current, "feature-branch-base");
		expect(result.warnings[0]).toMatch(/feature-branch-base/);
	});
});

// ===========================================
// computeDecisionSurfaceRatchet — orchestrator
// ===========================================

describe("computeDecisionSurfaceRatchet — git orchestration", () => {
	let tmpProjectDir: string | undefined;

	afterEach(() => {
		forceBaselineDetectError.value = false;
		if (tmpProjectDir !== undefined) {
			rmSync(tmpProjectDir, { recursive: true, force: true });
			tmpProjectDir = undefined;
		}
	});

	it("skips with reason 'not-a-repo' when git rev-parse fails", () => {
		const result = computeDecisionSurfaceRatchet("/repo", {
			runGit: () => {
				throw new Error("not a git repository");
			},
		});
		expect(result.skipped).toBe("not-a-repo");
		expect(result.baselineRef).toBeNull();
		expect(result.warnings).toEqual([]);
	});

	it("skips with reason 'no-baseline-ref' when no candidate ref resolves", () => {
		const result = computeDecisionSurfaceRatchet("/repo", {
			runGit: (args) => {
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				throw new Error("unknown ref");
			},
		});
		expect(result.skipped).toBe("no-baseline-ref");
		expect(result.baselineRef).toBeNull();
		expect(result.warnings).toEqual([]);
	});

	it("uses the first candidate ref that resolves (origin/main preferred)", () => {
		const seenRefs: string[] = [];
		const result = computeDecisionSurfaceRatchet("/repo", {
			runGit: (args) => {
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				if (args[0] === "rev-parse" && args[1] === "--verify") {
					const ref = (args[2] ?? "").replace(/\^\{commit\}$/, "");
					seenRefs.push(ref);
					if (ref === "origin/main") return "abcdef";
					throw new Error("unknown ref");
				}
				if (args[0] === "merge-base") return "abcdef";
				// Tree at origin/main looks empty (no package.json, no lockfiles, etc.)
				if (args[0] === "ls-tree") return "";
				if (args[0] === "show" || args[0] === "cat-file") throw new Error("not found");
				throw new Error(`unexpected: ${args.join(" ")}`);
			},
		});
		expect(seenRefs[0]).toBe("origin/main");
		expect(result.baselineRef).toBe("origin/main");
		expect(result.skipped).toBeNull();
	});

	it("falls back to origin/master when origin/main is absent", () => {
		const result = computeDecisionSurfaceRatchet("/repo", {
			runGit: (args) => {
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				if (args[0] === "rev-parse" && args[1] === "--verify") {
					const ref = (args[2] ?? "").replace(/\^\{commit\}$/, "");
					if (ref === "origin/master") return "fedcba";
					throw new Error("unknown ref");
				}
				if (args[0] === "merge-base") return "fedcba";
				if (args[0] === "ls-tree") return "";
				if (args[0] === "show" || args[0] === "cat-file") throw new Error("not found");
				throw new Error(`unexpected: ${args.join(" ")}`);
			},
		});
		expect(result.baselineRef).toBe("origin/master");
	});

	it("orchestrator path does not throw on git output for unrelated git args", () => {
		// Smoke test: a minimal stub responds to everything; verify the
		// orchestrator doesn't throw and returns a sensible result.
		const result = computeDecisionSurfaceRatchet("/repo", {
			runGit: (args) => {
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				if (args[0] === "rev-parse" && args[1] === "--verify") {
					if ((args[2] ?? "").startsWith("origin/main")) return "abcdef";
					throw new Error("unknown ref");
				}
				if (args[0] === "merge-base") return "abcdef";
				return ""; // ls-tree empty, show/cat-file shouldn't be called for empty tree
			},
		});
		expect(result.skipped).toBeNull();
		expect(result.totalGrowth).toBeGreaterThanOrEqual(0);
	});

	it("skips with reason 'git-error' when reading the baseline detector throws", () => {
		forceBaselineDetectError.value = true;
		const result = computeDecisionSurfaceRatchet("/repo", {
			runGit: (args) => {
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				if (args[0] === "rev-parse" && args[1] === "--verify") {
					if ((args[2] ?? "").startsWith("origin/main")) return "abcdef";
					throw new Error("unknown ref");
				}
				if (args[0] === "merge-base") return "abcdef";
				throw new Error(`unexpected: ${args.join(" ")}`);
			},
		});
		// The catch converts the thrown baseline-read error into a distinct
		// skip reason — NOT "no-baseline-ref" (the ref resolved fine here) and
		// NOT a silent empty report.
		expect(result.skipped).toBe("git-error");
		expect(result.baselineRef).toBeNull();
		expect(result.warnings).toEqual([]);
	});

	it("reads the baseline package.json via `git show` and folds it into growth (readFile success path)", () => {
		const dir = mkdtempSync(join(tmpdir(), "decision-surface-ratchet-"));
		tmpProjectDir = dir;
		// CURRENT (real fs at `dir`): only jest.
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ devDependencies: { jest: "1.0.0" } }),
		);
		const result = computeDecisionSurfaceRatchet(dir, {
			runGit: (args) => {
				if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
				if (args[0] === "rev-parse" && args[1] === "--verify") {
					if ((args[2] ?? "").startsWith("origin/main")) return "abcdef";
					throw new Error("unknown ref");
				}
				if (args[0] === "merge-base") return "abcdef";
				if (args[0] === "ls-tree") return "";
				// BASELINE (git show at "origin/main" — resolveBaselineRef returns the
				// REF, not the resolved sha): both jest and vitest already present, so
				// the read must actually parse to suppress "jest" from growth below —
				// a failed read (catch → null) would leave the baseline empty and
				// "jest" would show up as new growth.
				if (args[0] === "show" && args[1] === "origin/main:package.json") {
					return JSON.stringify({ devDependencies: { jest: "1.0.0", vitest: "1.0.0" } });
				}
				if (args[0] === "cat-file") throw new Error("not found");
				throw new Error(`unexpected: ${args.join(" ")}`);
			},
		});
		expect(result.skipped).toBeNull();
		expect(result.growthByCategory.test_framework).toEqual([]);
		expect(result.totalGrowth).toBe(0);
	});
});

// ===========================================
// makeGitBackedOptions — toRelative's defensive fallback
// ===========================================

describe("makeGitBackedOptions — path outside cwd's prefix", () => {
	it("readFile passes the path through unchanged, so `git show` is keyed on the raw path", () => {
		const options = makeGitBackedOptions("/repo", "origin/main", (args) => {
			if (args[0] === "show" && args[1] === "origin/main:/elsewhere/package.json") {
				return "OUTSIDE-CONTENT";
			}
			throw new Error(`unexpected: ${args.join(" ")}`);
		});
		// If the fallback instead returned "" (treating every non-matching path
		// as cwd itself), `rel` would be "" and readFile would short-circuit to
		// null WITHOUT calling git show at all — this would come back null, not
		// the literal content below.
		expect(options.readFile?.("/elsewhere/package.json")).toBe("OUTSIDE-CONTENT");
	});
});
