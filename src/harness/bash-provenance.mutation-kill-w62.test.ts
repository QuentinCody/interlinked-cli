import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
import { describe, expect, it } from "vitest";
import { classifyBashCommandProvenance, recordBashTaintSource } from "./bash-provenance.js";
import type { SessionTrajectory } from "./types.js";

function makeSession(toolCallCount = 3): SessionTrajectory {
	return ({ ...completeSessionFixture(), ...{
		session_id: "s1",
		agent_name: "tester",
		tool_call_count: toolCallCount,
		sensitivity_level: "Public",
		taint_sources: [],
		// SAFETY: mirrors the fixture shape used by bash-provenance.test.ts —
		// recordBashTaintSource only reads taint_sources/tool_call_count.
	} });
}

describe("classifyBashCommandProvenance — mutation kill w62", () => {
	// test-contract: public-api — mutant da17d00688e1101d turns `!command`
	// into `false`, which would let the function fall through to the verb
	// loops on an empty string instead of returning null immediately.
	it("returns null for empty command (P1)", () => {
		expect(classifyBashCommandProvenance("")).toBeNull();
	});

	// test-contract: public-api — mutant fc7b93404fb0f48e turns the
	// curl/wget/http test into `true`, which would make ANY command
	// (even one with no fetch verb and no URL) enter the URL-check branch.
	it("returns null for a command with no curl/wget/http verb and no URL (N1)", () => {
		expect(classifyBashCommandProvenance("ls -la /tmp")).toBeNull();
	});

	// test-contract: public-api — mutant abb9521f2d4187bb turns
	// NON_LOCALHOST_HTTP_URL.test(command) into `true`, which would classify
	// a curl invocation with no URL at all as fetched_external.
	it("returns null for `curl` with no URL present at all (N2)", () => {
		expect(classifyBashCommandProvenance("curl --help")).toBeNull();
	});

	// test-contract: public-api — confirms the true-positive path the two
	// mutants above would corrupt: a real non-localhost URL classifies.
	it("classifies curl against a real non-localhost URL as fetched_external (P2)", () => {
		expect(classifyBashCommandProvenance("curl https://example.com/data")).toBe(
			"fetched_external",
		);
	});

	// test-contract: public-api — localhost carve-out documented in the
	// module header; a mutant collapsing the URL branches would also flip this.
	it("returns null for curl against localhost URL (P3 localhost carve-out)", () => {
		expect(classifyBashCommandProvenance("curl http://localhost:3000/api")).toBeNull();
	});
});

describe("recordBashTaintSource truncation — mutation kill w62", () => {
	// test-contract: invariant — mutant 4fc1c39d5669992d turns
	// `command.length > TAINT_FILE_MAX_LENGTH` into `true`, which would
	// truncate (and ellipsis-suffix) even a short command.
	it("stores a short command verbatim with no ellipsis (P4)", () => {
		const session = makeSession();
		const short = "gh issue view 42";
		recordBashTaintSource(session, short, "fetched_external");
		expect(session.taint_sources[0]?.file).toBe(`<bash:${short}>`);
		expect(session.taint_sources[0]?.file).not.toContain("…");
	});

	// test-contract: boundary — mutant 465b8a60dfca17a9 widens `>` to `>=`,
	// which would truncate a command exactly at the 200-char boundary that
	// the strict `>` comparison says must pass through untouched.
	it("does not truncate a command exactly at the max length boundary (P5)", () => {
		const session = makeSession();
		const exact = "a".repeat(200);
		recordBashTaintSource(session, exact, "fetched_external");
		expect(session.taint_sources[0]?.file).toBe(`<bash:${exact}>`);
		expect(session.taint_sources[0]?.file).not.toContain("…");
	});

	// test-contract: boundary — confirms the truncation side of the same
	// boundary mutant 465b8a60dfca17a9: one char over must truncate.
	it("truncates a command one char over the max length (boundary confirm)", () => {
		const session = makeSession();
		const over = "b".repeat(201);
		recordBashTaintSource(session, over, "fetched_external");
		const file = session.taint_sources[0]?.file ?? "";
		expect(file).toContain("…");
		expect(file).toBe(`<bash:${"b".repeat(200)}…>`);
	});

	// test-contract: invariant — mutant d98f372edf446ed1 replaces the
	// truncated-prefix template literal with an empty string; a long
	// command's stored `file` must retain the actual truncated prefix.
	it("retains the truncated prefix content, not an empty string (P6)", () => {
		const session = makeSession();
		const long = "x".repeat(250);
		recordBashTaintSource(session, long, "fetched_external");
		const file = session.taint_sources[0]?.file ?? "";
		expect(file).toContain("x".repeat(200));
		expect(file.length).toBeGreaterThan("<bash:…>".length);
	});
});

describe("GH/GLAB/npm/pip verb regexes require the single-space form — mutation kill w62", () => {
	// test-contract: public-api — mutants 4a923209eaef51f0 (https?→https) and
	// 1fa8d07881585ae6 (drop the `+` quantifier) target the generic URL
	// regex used elsewhere in this module; this pins the real gh-view shape.
	it("gh issue view classifies as fetched_external", () => {
		expect(classifyBashCommandProvenance("gh issue view 42")).toBe("fetched_external");
	});

	// test-contract: public-api — mutants 5dd18ab2b9ea1d09 / f9796047f102a4b4
	// collapse one `\s+` to `\s` in the gh-issue-view regex; a command that
	// has the verb but not "view" must stay unclassified either way.
	it("gh issue (without view) does not classify", () => {
		expect(classifyBashCommandProvenance("gh issue list")).toBeNull();
	});

	// test-contract: public-api — real gh-pr-view positive case.
	it("gh pr view classifies as fetched_external", () => {
		expect(classifyBashCommandProvenance("gh pr view 7")).toBe("fetched_external");
	});

	// test-contract: public-api — mutants 53e52b31ae02b46a / 6f01334732b1c055
	// target the gh-pr-view regex spacing; verb-without-view must stay null.
	it("gh pr (without view) does not classify", () => {
		expect(classifyBashCommandProvenance("gh pr list")).toBeNull();
	});

	// test-contract: public-api — real gh-gist-view positive case.
	it("gh gist view classifies as fetched_external", () => {
		expect(classifyBashCommandProvenance("gh gist view abcdef")).toBe("fetched_external");
	});

	// test-contract: public-api — mutants 007b91c909dd1c23 / 92c646863788ad14
	// target the gh-gist-view regex spacing; verb-without-view must stay null.
	it("gh gist (without view) does not classify", () => {
		expect(classifyBashCommandProvenance("gh gist list")).toBeNull();
	});

	// test-contract: public-api — real gh-api positive case.
	it("gh api classifies as fetched_external", () => {
		expect(classifyBashCommandProvenance("gh api /repos/foo/bar")).toBe("fetched_external");
	});

	// test-contract: public-api — mutant 0890e060ead71766 collapses the
	// `\s+` in the gh-api regex; an unrelated gh subcommand must stay null.
	it("gh (without api) does not classify", () => {
		expect(classifyBashCommandProvenance("gh auth status")).toBeNull();
	});

	// test-contract: public-api — real glab-issue-view positive case.
	it("glab issue view classifies as fetched_external", () => {
		expect(classifyBashCommandProvenance("glab issue view 12")).toBe("fetched_external");
	});

	// test-contract: public-api — mutants 1c1541f8759502ac / 7c797645ff8ec8b6
	// target the glab-issue-view regex spacing; verb-without-view stays null.
	it("glab issue (without view) does not classify", () => {
		expect(classifyBashCommandProvenance("glab issue list")).toBeNull();
	});

	// test-contract: public-api — real glab-mr-view positive case.
	it("glab mr view classifies as fetched_external", () => {
		expect(classifyBashCommandProvenance("glab mr view 3")).toBe("fetched_external");
	});

	// test-contract: public-api — mutants 69b448228d1b3081 / 47bf4ae911ae5473
	// target the glab-mr-view regex spacing; verb-without-view stays null.
	it("glab mr (without view) does not classify", () => {
		expect(classifyBashCommandProvenance("glab mr list")).toBeNull();
	});

	// test-contract: public-api — real npm-view positive case.
	it("npm view classifies as fetched_external", () => {
		expect(classifyBashCommandProvenance("npm view lodash")).toBe("fetched_external");
	});

	// test-contract: public-api — mutant 673703647407974e collapses the
	// `\s+` in the npm-view regex; a differently-verbed npm command stays null.
	it("npm (without view) does not classify", () => {
		expect(classifyBashCommandProvenance("npm install lodash")).toBeNull();
	});

	// test-contract: public-api — real pip-show positive case.
	it("pip show classifies as fetched_external", () => {
		expect(classifyBashCommandProvenance("pip show requests")).toBe("fetched_external");
	});

	// test-contract: public-api — mutant a22cd0fd5636fad1 collapses the
	// `\s+` in the pip-show regex; a differently-verbed pip command stays null.
	it("pip (without show) does not classify", () => {
		expect(classifyBashCommandProvenance("pip install requests")).toBeNull();
	});
});
