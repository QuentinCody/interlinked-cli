import { describe, expect, it } from "vitest";
import {
	canonicalizeOverlayManifest,
	checkGitWildmatchPattern,
	checkOverlayIncludeRules,
	DEFAULT_OVERLAY_INCLUDE_RULES,
	matchesGitWildmatchV1,
	MAX_OVERLAY_INCLUDE_RULES,
	normalizeGitWildmatchPattern,
	selectOverlayPaths,
	SHADOW_OVERLAY_DENY_V1,
} from "./overlay-manifest.js";
import { asCanonicalPath } from "./path-rules.js";
import type { OverlayIncludeRuleV1, OverlayManifestV1 } from "./types-core.js";

function exact(path: string): OverlayIncludeRuleV1 {
	return { kind: "exact", path: asCanonicalPath(path) };
}
function glob(pattern: string): OverlayIncludeRuleV1 {
	return { kind: "gitwildmatch-v1", pattern };
}
function manifestOf(rules: readonly OverlayIncludeRuleV1[]): OverlayManifestV1 {
	return { schema_version: 1, include_rules: rules, deny_ruleset_id: "shadow-overlay-deny-v1" };
}
function okOrThrow(manifest: OverlayManifestV1) {
	const result = canonicalizeOverlayManifest(manifest);
	if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.detail}`);
	return result;
}
/** The rejection reason, or "ok" — keeps the assertions branch-free. */
function rejectionOf(manifest: OverlayManifestV1): string {
	const result = canonicalizeOverlayManifest(manifest);
	return result.ok ? "ok" : result.reason;
}

describe("gitwildmatch-v1 — positive (must accept)", () => {
	it("P1: '**' crosses '/' — leading, trailing and embedded", () => {
		expect(matchesGitWildmatchV1("scratch/**", "scratch/probe.mts")).toBe(true);
		expect(matchesGitWildmatchV1("scratch/**", "scratch/a/b/c/deep.ts")).toBe(true);
		expect(matchesGitWildmatchV1("**/notes.md", "notes.md")).toBe(true);
		expect(matchesGitWildmatchV1("**/notes.md", "a/b/notes.md")).toBe(true);
		expect(matchesGitWildmatchV1("a/**/b.txt", "a/b.txt")).toBe(true);
		expect(matchesGitWildmatchV1("a/**/b.txt", "a/x/y/b.txt")).toBe(true);
	});

	it("P2: '*' matches within one segment, '?' matches one non-'/' character", () => {
		expect(matchesGitWildmatchV1("scratch/*.mts", "scratch/probe.mts")).toBe(true);
		expect(matchesGitWildmatchV1("scratch/probe.?ts", "scratch/probe.mts")).toBe(true);
		expect(matchesGitWildmatchV1("*.local.*", "config.local.json")).toBe(true);
	});

	it("P3: a dotfile IS matched by '*' (this grammar is not shell globbing)", () => {
		expect(matchesGitWildmatchV1("scratch/*", "scratch/.hidden")).toBe(true);
		expect(matchesGitWildmatchV1("**/*", ".gitignore")).toBe(true);
		expect(matchesGitWildmatchV1("scratch/**", "scratch/.env.sample")).toBe(true);
	});

	it("P4: character class and its negation", () => {
		expect(matchesGitWildmatchV1("scratch/[a-z]robe.mts", "scratch/probe.mts")).toBe(true);
		expect(matchesGitWildmatchV1("scratch/[!A-Z]robe.mts", "scratch/probe.mts")).toBe(true);
		expect(matchesGitWildmatchV1("scratch/[^A-Z]robe.mts", "scratch/probe.mts")).toBe(true);
	});

	it("P5: a leading '/' anchors to the repo root; a bare name matches at any depth", () => {
		expect(matchesGitWildmatchV1("/scratch/probe.mts", "scratch/probe.mts")).toBe(true);
		expect(matchesGitWildmatchV1("notes.md", "deep/dir/notes.md")).toBe(true);
	});

	it("P6: a trailing '/' matches a directory prefix", () => {
		expect(matchesGitWildmatchV1("scratch/", "scratch/probe.mts")).toBe(true);
		expect(matchesGitWildmatchV1("scratch/", "scratch/a/b.txt")).toBe(true);
	});

	it("P7: paths with spaces and newlines match", () => {
		expect(matchesGitWildmatchV1("scratch/**", "scratch/a folder/my file.txt")).toBe(true);
		expect(matchesGitWildmatchV1("scratch/**", "scratch/line\nbreak/file.txt")).toBe(true);
		expect(matchesGitWildmatchV1("scratch/*", "scratch/my file.txt")).toBe(true);
	});

	it("P8: checkGitWildmatchPattern accepts the documented subset", () => {
		for (const pattern of ["scratch/**", "*.local.*", "/a/b", "a/**/b", "x[!a-c]y", "dir/"]) {
			expect(checkGitWildmatchPattern(pattern, "pattern"), pattern).toBeNull();
		}
	});
});

describe("gitwildmatch-v1 — negative (must reject)", () => {
	it("N1: '*' never crosses a '/'", () => {
		expect(matchesGitWildmatchV1("scratch/*", "scratch/a/b.txt")).toBe(false);
		// "*" alone is a basename rule (P5), so anchor it to see the segment
		// boundary: "/*" is one root segment and never spans a directory.
		expect(matchesGitWildmatchV1("/*", "a/b")).toBe(false);
		expect(matchesGitWildmatchV1("scratch/*.mts", "scratch/nested/probe.mts")).toBe(false);
	});

	it("N2: matching is CASE-SENSITIVE", () => {
		expect(matchesGitWildmatchV1("Scratch/**", "scratch/probe.mts")).toBe(false);
		expect(matchesGitWildmatchV1("scratch/**", "Scratch/probe.mts")).toBe(false);
		expect(matchesGitWildmatchV1("*.LOCAL.*", "config.local.json")).toBe(false);
	});

	it("N3: '?' does not match '/' and a class does not match '/'", () => {
		expect(matchesGitWildmatchV1("a?b", "a/b")).toBe(false);
		expect(matchesGitWildmatchV1("a[/]b", "a/b")).toBe(false);
	});

	it("N4: an anchored pattern does not match at depth; a trailing '/**' needs content", () => {
		expect(matchesGitWildmatchV1("/notes.md", "deep/notes.md")).toBe(false);
		expect(matchesGitWildmatchV1("scratch/**", "scratch")).toBe(false);
		expect(matchesGitWildmatchV1("scratch/", "scratch")).toBe(false);
	});

	it("N5: rejects '..' segments, NUL, backslash, empty and over-cap patterns", () => {
		const reasons = [
			checkGitWildmatchPattern("../escape/**", "pattern"),
			checkGitWildmatchPattern("a/../b", "pattern"),
			checkGitWildmatchPattern("a\0b", "pattern"),
			checkGitWildmatchPattern("a\\b", "pattern"),
			checkGitWildmatchPattern("", "pattern"),
			checkGitWildmatchPattern(`${"a".repeat(4097)}`, "pattern"),
			checkGitWildmatchPattern(42, "pattern"),
		];
		for (const reason of reasons) expect(reason).not.toBeNull();
		expect(matchesGitWildmatchV1("../escape/**", "escape/x")).toBe(false);
	});

	it("N6: rejects an unterminated or empty character class", () => {
		expect(checkGitWildmatchPattern("a[bc", "pattern")).not.toBeNull();
		expect(checkGitWildmatchPattern("a[]b", "pattern")).not.toBeNull();
		expect(matchesGitWildmatchV1("a[bc", "a[bc")).toBe(false);
	});
});

describe("overlay manifest defaults + deny ruleset — positive (must accept)", () => {
	it("P1: the v0 default list is exactly the memo's seven exact baselines — no pattern rule, no scratch/** (a pattern over a gitignored tree defeats MAX_IGNORED_CANDIDATES; opt in per manifest instead)", () => {
		const exactPaths = DEFAULT_OVERLAY_INCLUDE_RULES.filter((r) => r.kind === "exact").map((r) =>
			r.kind === "exact" ? String(r.path) : "",
		);
		expect(exactPaths).toEqual([
			".interlinked/coverage-baseline.json",
			".interlinked/coverage-edit-baseline.json",
			".interlinked/mutation-baseline.json",
			".interlinked/large-files-baseline.json",
			".interlinked/untested-files-baseline.json",
			".interlinked/metric-caps.json",
			".interlinked/guard-rules.json",
		]);
		expect(DEFAULT_OVERLAY_INCLUDE_RULES).toHaveLength(7);
		expect(DEFAULT_OVERLAY_INCLUDE_RULES.filter((r) => r.kind === "gitwildmatch-v1")).toEqual([]);
	});

	it("P2: every exact baseline path travels under the default manifest", () => {
		const manifest = manifestOf(DEFAULT_OVERLAY_INCLUDE_RULES);
		const paths = [
			".interlinked/coverage-baseline.json",
			".interlinked/coverage-edit-baseline.json",
			".interlinked/mutation-baseline.json",
			".interlinked/large-files-baseline.json",
			".interlinked/untested-files-baseline.json",
			".interlinked/metric-caps.json",
			".interlinked/guard-rules.json",
		];
		const selection = selectOverlayPaths(manifest, paths);
		expect(selection.included).toEqual(paths.slice().sort());
		expect(selection.denied).toEqual([]);
	});

	it("P3: scratch/** is NOT in the default — a caller opts in per manifest, and once added it travels, including nested and dotted files", () => {
		// The default alone never carries scratch/ (see P1); this proves the
		// opt-in path works once a caller adds the rule explicitly.
		const optedIn = [...DEFAULT_OVERLAY_INCLUDE_RULES, { kind: "gitwildmatch-v1", pattern: "scratch/**" } as const];
		const defaultOnly = selectOverlayPaths(manifestOf(DEFAULT_OVERLAY_INCLUDE_RULES), ["scratch/probe.mts"]);
		expect(defaultOnly.included).toEqual([]);
		expect(defaultOnly.denied).toEqual([]);
		const selection = selectOverlayPaths(manifestOf(optedIn), [
			"scratch/probe.mts",
			"scratch/a/b/deep.json",
			"scratch/.keep",
		]);
		expect(selection.included).toHaveLength(3);
		expect(selection.denied).toEqual([]);
	});

	it("P4: the deny ruleset is broker-owned — id plus its own pattern text", () => {
		expect(SHADOW_OVERLAY_DENY_V1.id).toBe("shadow-overlay-deny-v1");
		expect([...SHADOW_OVERLAY_DENY_V1.patterns]).toEqual([
			"config.local.json",
			"mutation-cloud-v3.local.json",
			"guard-rules.local.json",
			"*.local.*",
		]);
	});
});

describe("overlay manifest defaults + deny ruleset — negative (must reject)", () => {
	it("N1: a '*.local.*' file named EXPLICITLY by the manifest is still denied", () => {
		const manifest = manifestOf([
			exact(".interlinked/config.local.json"),
			exact(".interlinked/mutation-cloud-v3.local.json"),
			exact(".interlinked/guard-rules.local.json"),
			exact("scratch/creds.local.env"),
			glob("**/*.local.*"),
		]);
		const paths = [
			".interlinked/config.local.json",
			".interlinked/mutation-cloud-v3.local.json",
			".interlinked/guard-rules.local.json",
			"scratch/creds.local.env",
		];
		const selection = selectOverlayPaths(manifest, paths);
		expect(selection.included).toEqual([]);
		expect(selection.denied).toEqual(paths.slice().sort());
	});

	it("N2: a secret-shaped filename inside an opted-in scratch/** is denied when it is a *.local.* file", () => {
		// scratch/** is opt-in (see P1/P3) — this manifest adds it explicitly to
		// exercise the deny-wins-over-include rule on a pattern-selected path.
		const optedIn = [...DEFAULT_OVERLAY_INCLUDE_RULES, { kind: "gitwildmatch-v1", pattern: "scratch/**" } as const];
		const selection = selectOverlayPaths(manifestOf(optedIn), [
			"scratch/aws.local.credentials",
			"scratch/notes.md",
		]);
		expect(selection.included).toEqual(["scratch/notes.md"]);
		expect(selection.denied).toEqual(["scratch/aws.local.credentials"]);
	});

	it("N3: a path no include rule names does not travel", () => {
		const selection = selectOverlayPaths(manifestOf(DEFAULT_OVERLAY_INCLUDE_RULES), [
			"reference-repos/huge/file.bin",
			".interlinked/activity.jsonl",
		]);
		expect(selection.included).toEqual([]);
		expect(selection.denied).toEqual([]);
	});
});

describe("canonicalizeOverlayManifest — positive (must accept)", () => {
	it("P1: canonicalizes the default manifest and returns a 64-hex hash", () => {
		const result = okOrThrow(manifestOf(DEFAULT_OVERLAY_INCLUDE_RULES));
		expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(result.manifest.deny_ruleset_id).toBe("shadow-overlay-deny-v1");
	});

	it("P2: sorting is canonical — exact rules first, each group bytewise", () => {
		const result = okOrThrow(manifestOf([glob("scratch/**"), exact("b.json"), glob("a/**"), exact("a.json")]));
		expect(result.manifest.include_rules).toEqual([
			{ kind: "exact", path: "a.json" },
			{ kind: "exact", path: "b.json" },
			{ kind: "gitwildmatch-v1", pattern: "a/**" },
			{ kind: "gitwildmatch-v1", pattern: "scratch/**" },
		]);
	});

	it("P3: the same rules in a different order give the SAME hash", () => {
		const forwards = okOrThrow(manifestOf(DEFAULT_OVERLAY_INCLUDE_RULES));
		const backwards = okOrThrow(manifestOf([...DEFAULT_OVERLAY_INCLUDE_RULES].reverse()));
		expect(backwards.hash).toBe(forwards.hash);
		expect(backwards.manifest.include_rules).toEqual(forwards.manifest.include_rules);
	});

	it("P4: a redundant leading '/' normalizes, so /scratch/** and scratch/** are one rule", () => {
		expect(normalizeGitWildmatchPattern("/scratch/**")).toBe("scratch/**");
		expect(normalizeGitWildmatchPattern("/notes.md")).toBe("/notes.md");
		const result = okOrThrow(manifestOf([glob("/scratch/**")]));
		expect(result.hash).toBe(okOrThrow(manifestOf([glob("scratch/**")])).hash);
	});

	it("P5: a different rule set gives a different hash", () => {
		const one = okOrThrow(manifestOf([exact("a.json")]));
		const two = okOrThrow(manifestOf([exact("b.json")]));
		expect(two.hash).not.toBe(one.hash);
	});

	it("P6: the shared validator accepts non-canonical order in 'any-order' mode and canonical order in 'canonical' mode", () => {
		const unsorted = [glob("scratch/**"), exact("b.json"), exact("a.json")];
		expect(checkOverlayIncludeRules(unsorted, "rules", "any-order")).toBeNull();
		const sorted = okOrThrow(manifestOf(unsorted)).manifest.include_rules;
		expect(checkOverlayIncludeRules(sorted, "rules", "canonical")).toBeNull();
	});

	it("P7: canonicalizing an already-canonical manifest is the identity — same rules, same hash", () => {
		const first = okOrThrow(manifestOf([glob("scratch/**"), exact("b.json"), exact("a.json")]));
		const again = okOrThrow(first.manifest);
		expect(again.manifest).toEqual(first.manifest);
		expect(again.hash).toBe(first.hash);
	});
});

describe("canonicalizeOverlayManifest — negative (must reject)", () => {
	it("N1: rejects a duplicate exact path", () => {
		expect(rejectionOf(manifestOf([exact("a.json"), exact("a.json")]))).toBe("duplicate_rule");
	});

	it("N2: rejects a duplicate pattern after normalization", () => {
		expect(rejectionOf(manifestOf([glob("scratch/**"), glob("/scratch/**")]))).toBe("duplicate_rule");
	});

	it("N3: rejects an invalid pattern, an invalid exact path and an unknown rule kind", () => {
		const bad = [
			[glob("../escape/**")],
			[{ kind: "exact", path: "../escape.json" }],
			[{ kind: "wildmatch-v2", pattern: "x" }],
		];
		// SAFETY: the test feeds deliberately malformed wire shapes through the
		// declared type so the runtime validator, not the compiler, rejects them.
		const reasons = bad.map((rules) => rejectionOf(manifestOf(rules as readonly OverlayIncludeRuleV1[])));
		expect(reasons).toEqual(["invalid_rule", "invalid_rule", "invalid_rule"]);
	});

	it("N4: rejects a wrong schema_version, a caller-supplied deny ruleset id and unknown keys", () => {
		const shapes = [
			{ schema_version: 2, include_rules: [], deny_ruleset_id: "shadow-overlay-deny-v1" },
			{ schema_version: 1, include_rules: [], deny_ruleset_id: "caller-owned-deny" },
			{ schema_version: 1, include_rules: [], deny_ruleset_id: "shadow-overlay-deny-v1", deny_text: ["x"] },
		];
		// SAFETY: same as N3 — malformed wire shapes must be refused at runtime.
		const reasons = shapes.map((shape) => rejectionOf(shape as unknown as OverlayManifestV1));
		expect(reasons).toEqual(["invalid_manifest", "invalid_manifest", "invalid_manifest"]);
	});

	it("N5: rejects an empty rule list", () => {
		expect(rejectionOf(manifestOf([]))).toBe("invalid_manifest");
	});

	it("N6: rejects more rules than the cap", () => {
		const rules = Array.from({ length: MAX_OVERLAY_INCLUDE_RULES + 1 }, (_, i) => exact(`f${i}.json`));
		expect(rejectionOf(manifestOf(rules))).toBe("too_many_rules");
	});

	it("N8: rejects an impossible character class ([z-a]) as invalid_rule", () => {
		expect(rejectionOf(manifestOf([glob("[z-a]")]))).toBe("invalid_rule");
	});

	it("N9: the shared validator in 'canonical' mode refuses order drift, an un-normalized pattern, and a pattern before an exact rule", () => {
		const detail = (rules: readonly OverlayIncludeRuleV1[]): string =>
			checkOverlayIncludeRules(rules, "rules", "canonical")?.detail ?? "ok";
		expect(detail([exact("b.json"), exact("a.json")])).toContain("canonical");
		expect(detail([glob("/scratch/**")])).toContain("canonical");
		expect(detail([glob("scratch/**"), exact("a.json")])).toContain("canonical");
	});

	it("N10: the shared validator classifies empty, over-cap, duplicate and invalid lists the same way the canonicalizer does", () => {
		const reason = (rules: unknown): string => checkOverlayIncludeRules(rules, "rules", "any-order")?.reason ?? "ok";
		expect(reason([])).toBe("invalid_manifest");
		expect(reason("not-a-list")).toBe("invalid_manifest");
		expect(reason(Array.from({ length: MAX_OVERLAY_INCLUDE_RULES + 1 }, (_, i) => exact(`f${i}.json`)))).toBe(
			"too_many_rules",
		);
		expect(reason([exact("a.json"), exact("a.json")])).toBe("duplicate_rule");
		expect(reason([glob("[z-a]")])).toBe("invalid_rule");
	});

	it("N7: selectOverlayPaths refuses a non-canonical candidate path rather than including it", () => {
		const selection = selectOverlayPaths(manifestOf([glob("**/*")]), ["../escape.json", "/abs.json", "ok.json"]);
		expect(selection.included).toEqual(["ok.json"]);
		expect(selection.denied).toEqual([]);
	});
});
