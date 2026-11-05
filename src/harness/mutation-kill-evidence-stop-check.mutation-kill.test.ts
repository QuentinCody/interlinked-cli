// Mutation-kill tests for the Stop-time mutation-kill-evidence check — 2026-11-05 dogfood
// campaign (docs/reviews/kill-proof-dogfood.md): the literal-title grammar and the exact
// new-case titles the receipt reader is asked to certify. In-memory fakes, no git, no fs.
import { describe, expect, it, vi } from "vitest";
import { countCaseTitles, detectMutationKillEvidenceGaps, newCaseTitles } from "./mutation-kill-evidence-stop-check.js";

const CWD = "/repo";
const FILE = "/repo/src/checks/foo.mutation-kill.test.ts";
const FILE_REL = "src/checks/foo.mutation-kill.test.ts";
const marked = (title: string, opener = "it"): string => `// test-contract: bug — kills the boundary mutant\n${opener}("${title}", () => { expect(1).toBe(1); });\n`;

function requiredCases(current: string, baseline: string): (readonly string[])[] {
	const freshKillProofs = vi.fn((_cwd: string, _rel: string, newCases: readonly string[]) => (newCases.length ? 1 : 0));
	detectMutationKillEvidenceGaps({
		filesWritten: new Set([FILE]), fileWriteTimes: new Map([[FILE, "2026-11-05T10:00:00.000Z"]]), gitHeadSha: "deadbeef", cwd: CWD,
		gitShow: (_cwd, ref) => (ref.endsWith(`:${FILE_REL}`) ? baseline : null), readFile: abs => (abs === FILE ? current : null), loadMutationManifest: () => null, freshKillProofs,
	});
	return freshKillProofs.mock.calls.map(call => call[2]);
}

describe("newCaseTitles / countCaseTitles — the literal-title grammar", () => {
	// test-contract: public-api - the new titles are exactly those present now and absent from the baseline, never the ones the baseline already had
	it("returns the added titles and not the retained ones", () => {
		expect(newCaseTitles("it('old', () => {});\nit('new', () => {});\n", "it('old', () => {});\n")).toEqual(["new"]);
		expect(newCaseTitles("it('old', () => {});\n", "it('old', () => {});\n")).toEqual([]);
	});
	// test-contract: public-api - `test(...)` declares a case exactly as `it(...)` does
	it("a `test(` opener's title is a literal case title", () => {
		expect(countCaseTitles('test("via test", () => {});\n')).toBe(1);
		expect(newCaseTitles('test("via test", () => {});\n', "")).toEqual(["via test"]);
	});
});

describe("detectMutationKillEvidenceGaps — the titles the receipt must have killed", () => {
	// test-contract: invariant - the receipt reader is asked for the NEW titles (review K4): an old strong case must not certify a new weak one
	it("asks the kill-proof reader for exactly the newly added titles", () => {
		expect(requiredCases(marked("old") + marked("new case"), marked("old"))).toEqual([["new case"]]);
	});
	// test-contract: boundary - a title on the line after `it(` grows the title count but not the opener count; it is still a new title the receipt must have killed (review L4)
	it("a title on the line after `it(` is still required of the receipt", () => {
		const current = `${marked("old")}// test-contract: bug — kills the boundary mutant\nit(\n\t"wrapped title", () => { expect(1).toBe(1); });\n`;
		expect(requiredCases(current, marked("old"))).toEqual([["wrapped title"]]);
	});
});
