import { describe, expect, it, vi } from "vitest";
import { JevClient } from "./client.js";
import {
	extractTestBlocks,
	formatTitleBodyFindings,
	scoreTestTitles,
	TITLE_BODY_MISMATCH_NOUL_MAX,
} from "./test-title-body.js";

const FILE = `import { describe, it, expect } from "vitest";
describe("x", () => {
	it("returns null for an empty input", () => {
		expect(parse("")).toBeNull();
	});
	it.skip("throws on malformed input", () => {
		expect(() => parse("{")).toThrow();
	});
	test("P1: counts the lines", () => {
		const n = count("a\\nb");
		expect(n).toBe(2);
	});
});
`;

function clientAnswering(matches: number, verdict: string): JevClient {
	const fetchImpl = vi.fn(async () =>
		new Response(
			JSON.stringify({
				model: "jev-test",
				answers: {
					matches: { type: "noul", noul: matches },
					verdict: { type: "choice", choice: verdict, probabilities: { match: 0.1, partial: 0.1, mismatch: 0.8 }, confidence: 0.7 },
				},
				usage: { input_tokens: 10, output_tokens: 1 },
			}),
			{ status: 200 },
		),
	);
	return new JevClient({ apiKey: "k", fetchImpl });
}

describe("extractTestBlocks — positive (must fire)", () => {
	it("P1: finds every it/test block with its title, body and 1-based line", () => {
		const blocks = extractTestBlocks(FILE);
		expect(blocks.map((b) => b.title)).toEqual([
			"returns null for an empty input",
			"throws on malformed input",
			"P1: counts the lines",
		]);
		expect(blocks.map((b) => b.line)).toEqual([3, 6, 9]);
		expect(blocks[0]?.body).toContain("toBeNull()");
		expect(blocks[2]?.body).toContain("toBe(2)");
	});
});

describe("extractTestBlocks — negative (must not fire)", () => {
	it("N1: a file with no test blocks yields nothing", () => {
		expect(extractTestBlocks("export const x = 1;\n")).toEqual([]);
	});
});

describe("scoreTestTitles — positive (must fire)", () => {
	it("P1: reports a block the model scores as a mismatch below the operating point", async () => {
		const findings = await scoreTestTitles(clientAnswering(TITLE_BODY_MISMATCH_NOUL_MAX - 0.1, "mismatch"), "src/x.test.ts", FILE);
		expect(findings).toHaveLength(3);
		expect(findings[0]).toMatchObject({ line: 3, title: "returns null for an empty input", verdict: "mismatch" });
	});
});

describe("scoreTestTitles — negative (must not fire)", () => {
	it("N1: a confident match is not reported", async () => {
		expect(await scoreTestTitles(clientAnswering(0.9, "match"), "src/x.test.ts", FILE)).toEqual([]);
	});
	it("N2: a mismatch verdict with a matches score above the operating point is not reported (both signals required)", async () => {
		expect(await scoreTestTitles(clientAnswering(0.8, "mismatch"), "src/x.test.ts", FILE)).toEqual([]);
	});
	it("N3: a failing client (null answers) yields no findings rather than throwing", async () => {
		const client = new JevClient({ apiKey: "k", fetchImpl: async () => new Response("nope", { status: 500 }) });
		expect(await scoreTestTitles(client, "src/x.test.ts", FILE)).toEqual([]);
	});
});

describe("formatTitleBodyFindings", () => {
	it("P1: one line per finding with file:line, title and the two scores", () => {
		const lines = formatTitleBodyFindings("src/x.test.ts", [
			{ line: 3, title: "returns null for an empty input", matches: 0.2, verdict: "mismatch", confidence: 0.7 },
		]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("[interlinked:jev-test-title]");
		expect(lines[0]).toContain("src/x.test.ts:3");
		expect(lines[0]).toContain("returns null for an empty input");
		expect(lines[0]).toContain("0.20");
	});
	it("N1: no findings → no lines", () => {
		expect(formatTitleBodyFindings("src/x.test.ts", [])).toEqual([]);
	});
});
