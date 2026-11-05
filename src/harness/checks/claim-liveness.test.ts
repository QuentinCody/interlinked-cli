import { describe, expect, it } from "vitest";
import {
	type ClaimLivenessInput,
	type ClaimSource,
	detectClaimLiveness,
	extractPathMentions,
	LIVENESS_VERB_RE,
	resolveMention,
	splitIntoSentences,
	splitMarkdownParagraphs,
} from "./claim-liveness.js";

// Spike detector (unregistered). The pure core takes the file list, the
// importer callback and the entry list explicitly, so every case below is a
// closed world: nothing is read from disk.

const FILES = [
	"src/index.ts",
	"src/harness/server.ts",
	"src/harness/foo.ts",
	"src/harness/foo.test.ts",
	"src/harness/__tests__/foo-extra.test.ts",
	"src/harness/evaluator/gate.ts",
	"src/harness/a/store.ts",
	"src/harness/b/store.ts",
	"src/harness/check-evidence/corpus-scan.ts",
	"scripts/scan-things.mts",
	"scratch/probe.ts",
	"docs/example.ts",
	"src/harness/__fixtures__/fixture-server.ts",
];

const doc = (text: string, source = "CLAUDE.md", line = 1): ClaimSource => ({ source, line, text });

function run(
	claims: ClaimSource[],
	importers: Record<string, string[]> = {},
	extra: Partial<ClaimLivenessInput> = {},
) {
	return detectClaimLiveness({
		claims,
		files: FILES,
		importers: (f) => importers[f] ?? [],
		...extra,
	});
}

describe("claim_liveness — positive (must fire)", () => {
	it("P1: a backtick path with a liveness verb in the same sentence and no importer", () => {
		const out = run([doc("The nudge in `src/harness/foo.ts` is wired into the Stop phase.")]);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ path: "src/harness/foo.ts", verb: "wired", source: "CLAUDE.md", line: 1, testImporters: 0 });
	});

	it("P2: a bare src/ path with 'now runs'", () => {
		const out = run([doc("src/harness/foo.ts now runs on every PostToolUse.", "docs/harness.md", 12)]);
		expect(out.map((f) => [f.path, f.verb, f.line])).toEqual([["src/harness/foo.ts", "now runs", 12]]);
	});

	it("P3: a file whose only importers are tests still fires, and reports them", () => {
		const out = run([doc("`src/harness/foo.ts` ships as the default-on scanner.")], {
			"src/harness/foo.ts": ["src/harness/foo.test.ts", "src/harness/__tests__/foo-extra.test.ts"],
		});
		expect(out).toHaveLength(1);
		expect(out[0]?.testImporters).toBe(2);
	});

	it("P4: a CLAUDE.md-style short path resolves by unique suffix", () => {
		const out = run([doc("`evaluator/gate.ts` lands the block in pre-tool.")]);
		expect(out.map((f) => [f.written, f.path])).toEqual([["evaluator/gate.ts", "src/harness/evaluator/gate.ts"]]);
	});

	it("P5: a table row is one claim unit", () => {
		const out = run([doc("| `src/harness/foo.ts` | Stop nudge; enabled by default |")]);
		expect(out).toHaveLength(1);
		expect(out[0]?.verb).toBe("enabled");
	});

	it("P6: a commit message is a claim source", () => {
		const out = run([doc("feat(harness): foo gate\n\nsrc/harness/foo.ts is called from the daemon on every edit.", "commit:abc1234")]);
		expect(out).toHaveLength(1);
		expect(out[0]?.source).toBe("commit:abc1234");
	});

	it("P7: iteration 2 — a unique backtick basename resolves when basenames is on", () => {
		const claim = doc("Supporting modules: `corpus-scan.ts` (dogfood runs + adjudication).");
		expect(run([claim])).toHaveLength(0);
		const out = run([claim], {}, { basenames: true });
		expect(out.map((f) => f.path)).toEqual(["src/harness/check-evidence/corpus-scan.ts"]);
	});

	it("P8: a self-import does not count as an importer", () => {
		const out = run([doc("`src/harness/foo.ts` runs the sweep.")], { "src/harness/foo.ts": ["src/harness/foo.ts"] });
		expect(out).toHaveLength(1);
	});
});

describe("claim_liveness — negative (must not fire)", () => {
	it("N1: any non-test importer (static, barrel, dynamic or require is the caller's job) silences it", () => {
		const out = run([doc("`src/harness/foo.ts` is wired into the daemon.")], { "src/harness/foo.ts": ["src/harness/server.ts"] });
		expect(out).toEqual([]);
	});

	it("N2: an entry point is reachable without an importer — supplied list and path shape", () => {
		expect(run([doc("`src/harness/server.ts` runs as the daemon.")], {}, { entryPoints: ["src/harness/server.ts"] })).toEqual([]);
		expect(run([doc("`scripts/scan-things.mts` runs in CI.")])).toEqual([]);
		expect(run([doc("`src/index.ts` is live.")])).toEqual([]);
	});

	it("N3: the verb and the path must share a sentence, and 'live in' locates rather than claims", () => {
		expect(run([doc("The gate is wired in the pipeline. Its helpers sit in `src/harness/foo.ts`.")])).toEqual([]);
		expect(run([doc("Its helpers live in `src/harness/foo.ts`.")])).toEqual([]);
	});

	it("N4: a negated claim is not a claim", () => {
		expect(run([doc("`src/harness/foo.ts` is not wired yet.")])).toEqual([]);
		expect(run([doc("`src/harness/foo.ts` was never enabled.")])).toEqual([]);
	});

	it("N5: tests, fixtures, scratch and docs paths are not product code", () => {
		const out = run([
			doc("`src/harness/foo.test.ts` runs in CI."),
			doc("`src/harness/__fixtures__/fixture-server.ts` is live."),
			doc("`scratch/probe.ts` runs the probe."),
			doc("`docs/example.ts` ships with the guide."),
		]);
		expect(out).toEqual([]);
	});

	it("N6: a path inside a fenced code block is an example, not a claim", () => {
		const md = "Run it:\n\n```bash\nnpx tsx src/harness/foo.ts  # runs the sweep\n```\n";
		expect(run(splitMarkdownParagraphs(md, "docs/x.md"))).toEqual([]);
	});

	it("N7: an ambiguous short path or basename resolves to nothing", () => {
		expect(run([doc("`a/store.ts` and `store.ts` are enabled.")], {}, { basenames: true }).map((f) => f.path)).toEqual([
			"src/harness/a/store.ts",
		]);
		expect(run([doc("`store.ts` is enabled.")], {}, { basenames: true })).toEqual([]);
	});

	it("N8: a sentence with no liveness verb, or a file that does not exist, is silent", () => {
		expect(run([doc("`src/harness/foo.ts` holds the shared types.")])).toEqual([]);
		expect(run([doc("`src/harness/missing.ts` is wired in.")])).toEqual([]);
	});

	it("N9: a second mention of the same file in one paragraph is reported once", () => {
		const out = run([doc("`src/harness/foo.ts` is wired. `src/harness/foo.ts` runs on Stop.")]);
		expect(out).toHaveLength(1);
	});
});

describe("claim_liveness — grammar helpers", () => {
	it("P9: splits sentences at punctuation + capital, semicolons, list items and table rows", () => {
		expect(splitIntoSentences("A gate in `x.ts` is wired. Next one; and another\n- item one\n| row. Two; cells |")).toEqual([
			"A gate in `x.ts` is wired.",
			"Next one",
			"and another",
			"- item one",
			"| row. Two; cells |",
		]);
	});

	it("N10: a dot inside a path does not split, and the verb list has word boundaries", () => {
		expect(splitIntoSentences("`src/harness/foo.ts` is wired into pre-tool.ts and runs")).toHaveLength(1);
		expect(LIVENESS_VERB_RE.test("the module lives in src/harness and was delivered")).toBe(false);
		expect(LIVENESS_VERB_RE.test("enabled_rules is a config key")).toBe(false);
	});

	it("P10: extracts backtick paths, bare src/ paths, and strips ./", () => {
		expect(extractPathMentions("see `./src/harness/foo.ts`, src/harness/evaluator/gate.ts, and `--flag`")).toEqual([
			"src/harness/foo.ts",
			"src/harness/evaluator/gate.ts",
		]);
	});

	it("N11: a bare path is not read out of a longer one, nor with a trailing extension", () => {
		expect(extractPathMentions("cloud/src/x.ts and src/harness/foo.ts.bak")).toEqual([]);
		expect(resolveMention("harness/foo.ts", FILES)).toBe("src/harness/foo.ts");
		expect(resolveMention("src/nope.ts", FILES)).toBeNull();
	});
});
