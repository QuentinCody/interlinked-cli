import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	buildAgentSafetyChecks,
	buildCheckInstructions,
	buildGenericCheckMeta,
} from "./builders.js";
import { CHECK_REGISTRY } from "./registry.js";

function expectedAgentSafetyChecks(content: string): typeof CHECK_REGISTRY {
	const lc = content.toLowerCase();
	return CHECK_REGISTRY.filter((c) => c.pipeline === "agent_safety").filter((c) => {
		if (!c.content_keywords?.length) return true;
		return c.content_keywords.some((k) => lc.includes(k.toLowerCase()));
	});
}

describe("buildAgentSafetyChecks", () => {
	it("returns one entry per agent_safety check whose content_keywords are present (or absent — always-eval)", () => {
		const content = "";
		const all = buildAgentSafetyChecks(content, "x.ts");
		expect(all).toHaveLength(expectedAgentSafetyChecks(content).length);
	});

	it("includes content-keyword-gated checks when their keyword appears in the file", () => {
		// `subprocess` keyword unlocks ubs_subprocess_shell_true (and any
		// future `subprocess`-gated check); `Mutex` unlocks the Rust unwrap
		// detector. With an empty file none of the keyword-gated checks run;
		// with a single keyword in the content, the matching check appears.
		const empty = buildAgentSafetyChecks("", "x.ts").map((c) => c.name);
		const withSub = buildAgentSafetyChecks("import subprocess", "x.py").map(
			(c) => c.name,
		);
		expect(withSub).toContain("ubs_subprocess_shell_true");
		expect(empty).not.toContain("ubs_subprocess_shell_true");
	});

	it("filters by phase when passed", () => {
		const preBlock = buildAgentSafetyChecks("", "x.ts", "pre_block");
		for (const c of preBlock) {
			const entry = CHECK_REGISTRY.find((r) => r.id === c.name);
			expect(entry?.phase).toBe("pre_block");
		}
	});

	it("promotes test-quality checks to pre_warn while retaining post test-quality checks", () => {
		const broadTruthiness = `import { load } from "./subject.js";
test("loads", () => {
	expect(load()).toBeTruthy();
});`;
		const mockOnly = `test("calls dependency", () => {
	expect(handler).toHaveBeenCalled();
});`;
		const truthinessChecks = buildAgentSafetyChecks(
			broadTruthiness,
			"subject.test.ts",
			"pre_warn",
		);
		const mockOnlyChecks = buildAgentSafetyChecks(mockOnly, "subject.test.ts", "pre_warn");
		expect(new Set(truthinessChecks.map((check) => check.name))).toContain("test_legitimacy");
		expect(new Set(mockOnlyChecks.map((check) => check.name))).toContain("mock_only_test");
		expect(
			truthinessChecks.find((check) => check.name === "test_legitimacy")?.fn().length,
		).toBeGreaterThan(0);
		expect(mockOnlyChecks.find((check) => check.name === "mock_only_test")?.fn().length).toBeGreaterThan(0);

		const postContent = `test("accepts one", () => { expect(1).toBe(1); });
test("accepts two", () => { expect(2).toBe(2); });
test("accepts three", () => { expect(3).toBe(3); });`;
		const post = buildAgentSafetyChecks(postContent, "subject.test.ts", "post");
		const postNames = new Set(post.map((check) => check.name));
		expect(postNames).not.toContain("test_legitimacy");
		expect(postNames).not.toContain("mock_only_test");
		expect(postNames).toContain("happy_path_only_test");
		expect(post.find((check) => check.name === "happy_path_only_test")?.fn().length).toBeGreaterThan(0);
	});

	it("each built fn closes over the passed content + filePath", () => {
		// floating_promises fires on a known-async call at statement position.
		const checks = buildAgentSafetyChecks(
			"async function load() {}\nload();",
			"app.ts",
			"pre_warn",
		);
		const floating = checks.find((c) => c.name === "floating_promises");
		expect(nonNull(floating).fn().length).toBeGreaterThan(0);
	});

	// ===========================================
	// Phase B.4 — diff-class skip
	// ===========================================
	// When the caller passes a pre-edit content, buildAgentSafetyChecks
	// classifies the diff and skips warning-severity detectors when the
	// diff is non-semantic (whitespace_only / comment_only). Error-severity
	// detectors must STILL be returned — security checks fire on quoted
	// strings too in case a credential leaked there.

	it("preserves legacy run-everything when oldContent is undefined", () => {
		// Sanity check: omitting the new optional argument must not drop any
		// checks. This guards against an accidental default-active skip.
		const a = buildAgentSafetyChecks("foo", "x.ts");
		const b = buildAgentSafetyChecks("foo", "x.ts", undefined, undefined);
		expect(a.map((c) => c.name).sort()).toEqual(b.map((c) => c.name).sort());
	});

	it("does NOT skip warnings on comment_only diffs (quoted-string changes can be security-relevant)", () => {
		// `comment_only` per `diff-classifier.ts` covers diffs landing in any
		// masked region — comments AND quoted strings. Several warning
		// detectors specifically inspect quoted values (target_blank_no_rel
		// on JSX `target="_blank"`, hardcoded-localhost strings, weak-hash
		// literals like `"md5"`). Skipping warnings on `comment_only` would
		// silently drop those — the bug the reviewer flagged. Pin the fix:
		// a quoted-string-only diff still surfaces warning detectors.
		const oldText = "echo 'hello'";
		const newText = "echo 'world'";
		const skipped = buildAgentSafetyChecks(newText, "x.sh", undefined, oldText);
		const skippedWarnings = skipped.filter((c) => c.severity === "warning");
		expect(skippedWarnings.length).toBeGreaterThan(0);
	});

	it("preserves error-severity checks even on comment_only diffs", () => {
		// `eval()` is severity=error and MUST run regardless of diff_class.
		// We embed it in a quoted-string-only delta to verify the skip does
		// not drop it.
		const oldText = "const a = 'foo'; const x = eval(input);";
		const newText = "const a = 'bar'; const x = eval(input);";
		const skipped = buildAgentSafetyChecks(newText, "x.ts", undefined, oldText);
		const errorChecks = skipped.filter((c) => c.severity === "error");
		expect(errorChecks.length).toBeGreaterThan(0);
		expect(errorChecks.map((c) => c.name)).toContain("eval_usage");
	});

	it("runs every check when the diff is semantic", () => {
		// A real identifier change is semantic — every detector that would
		// have run with no oldContent must still run with oldContent.
		const oldText = "const a = 1;";
		const newText = "const b = 1;";
		const legacy = buildAgentSafetyChecks(newText, "x.ts");
		const withDiff = buildAgentSafetyChecks(newText, "x.ts", undefined, oldText);
		expect(legacy.map((c) => c.name).sort()).toEqual(withDiff.map((c) => c.name).sort());
	});

	it("skips warning-severity checks on whitespace_only diffs", () => {
		const oldText = "  const a = 1;";
		const newText = "    const a = 1;";
		const skipped = buildAgentSafetyChecks(newText, "x.ts", undefined, oldText);
		const skippedWarnings = skipped.filter((c) => c.severity === "warning");
		expect(skippedWarnings.length).toBe(0);
	});
});

describe("buildCheckInstructions", () => {
	it("returns a map from id to fix_instruction with one entry per registered check", () => {
		const map = buildCheckInstructions();
		expect(Object.keys(map)).toHaveLength(CHECK_REGISTRY.length);
		for (const c of CHECK_REGISTRY) {
			expect(map[c.id]).toBe(c.fix_instruction);
		}
	});
});

describe("buildGenericCheckMeta", () => {
	it("returns a map with name/description/tier/determinism per check", () => {
		const meta = buildGenericCheckMeta();
		expect(Object.keys(meta)).toHaveLength(CHECK_REGISTRY.length);
		for (const c of CHECK_REGISTRY) {
			expect(meta[c.id]).toEqual({
				name: c.name,
				description: c.description,
				tier: c.tier,
				determinism: c.determinism,
			});
		}
	});
});
