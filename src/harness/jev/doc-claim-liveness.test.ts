import { describe, expect, it, vi } from "vitest";
import { JevClient } from "./client.js";
import {
	DOC_CLAIM_LIVE_NOUL_MIN,
	extractPathParagraphs,
	formatDocClaimFindings,
	type ImporterResolver,
	scoreDocClaims,
} from "./doc-claim-liveness.js";

const DOC = `# Design

Intro paragraph with no paths at all, long enough to matter for the extractor here.

The gate now runs on every PostToolUse and is wired in src/harness/evaluator/foo-gate.ts; it blocks when the cap is crossed.

Planned: a future sweep would live in src/harness/sweep.ts once the runner exists.
`;

function clientWith(liveAny: number, perPath: number): JevClient {
	const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> }; // SAFETY: the client serializes exactly this shape
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: id === "live_any" ? liveAny : perPath };
		return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 1 } }), { status: 200 });
	});
	return new JevClient({ apiKey: "k", fetchImpl });
}

const NO_IMPORTERS: ImporterResolver = () => ({ exists: true, nonTestImporters: 0 });
const HAS_IMPORTERS: ImporterResolver = () => ({ exists: true, nonTestImporters: 3 });
const MISSING: ImporterResolver = () => ({ exists: false, nonTestImporters: 0 });

describe("extractPathParagraphs — positive (must fire)", () => {
	it("P1: returns only paragraphs that name a src path, with their 1-based start line", () => {
		const paras = extractPathParagraphs(DOC);
		expect(paras.map((p) => p.paths)).toEqual([["src/harness/evaluator/foo-gate.ts"], ["src/harness/sweep.ts"]]);
		expect(paras.map((p) => p.line)).toEqual([5, 7]);
	});
});

describe("extractPathParagraphs — negative (must not fire)", () => {
	it("N1: prose without paths yields nothing", () => {
		expect(extractPathParagraphs("just words\n\nmore words\n")).toEqual([]);
	});
});

describe("scoreDocClaims — positive (must fire)", () => {
	it("P1: a live claim about a path nothing imports is reported", async () => {
		const findings = await scoreDocClaims(clientWith(DOC_CLAIM_LIVE_NOUL_MIN + 0.1, 0.9), DOC, NO_IMPORTERS);
		expect(findings.map((f) => f.path)).toEqual(["src/harness/evaluator/foo-gate.ts", "src/harness/sweep.ts"]);
		expect(findings[0]).toMatchObject({ line: 5, nonTestImporters: 0, exists: true });
	});
	it("P2: a live claim about a path that does not exist is reported", async () => {
		const findings = await scoreDocClaims(clientWith(0.95, 0.9), DOC, MISSING);
		expect(findings).toHaveLength(2);
		expect(findings[0]?.exists).toBe(false);
	});
});

describe("scoreDocClaims — negative (must not fire)", () => {
	it("N1: a live claim about a path with non-test importers is not reported", async () => {
		expect(await scoreDocClaims(clientWith(0.95, 0.9), DOC, HAS_IMPORTERS)).toEqual([]);
	});
	it("N2: a paragraph below the live threshold is not reported even with zero importers", async () => {
		expect(await scoreDocClaims(clientWith(DOC_CLAIM_LIVE_NOUL_MIN - 0.1, 0.9), DOC, NO_IMPORTERS)).toEqual([]);
	});
	it("N3: a path the per-path Noul does not attribute the claim to is not reported", async () => {
		expect(await scoreDocClaims(clientWith(0.95, 0.2), DOC, NO_IMPORTERS)).toEqual([]);
	});
	it("N4: a failing client yields no findings", async () => {
		const client = new JevClient({ apiKey: "k", fetchImpl: async () => new Response("x", { status: 500 }) });
		expect(await scoreDocClaims(client, DOC, NO_IMPORTERS)).toEqual([]);
	});
});

describe("formatDocClaimFindings", () => {
	it("P1: names the doc line, the path and why it is suspect", () => {
		const lines = formatDocClaimFindings("docs/design/x.md", [
			{ line: 5, path: "src/harness/evaluator/foo-gate.ts", pLive: 0.9, pPath: 0.8, exists: true, nonTestImporters: 0 },
			{ line: 7, path: "src/harness/sweep.ts", pLive: 0.9, pPath: 0.8, exists: false, nonTestImporters: 0 },
		]);
		expect(lines[0]).toContain("[interlinked:jev-doc-claim]");
		expect(lines[0]).toContain("docs/design/x.md:5");
		expect(lines[0]).toContain("no non-test importer");
		expect(lines[1]).toContain("does not exist");
	});
});
