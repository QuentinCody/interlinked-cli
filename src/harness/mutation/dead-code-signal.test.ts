import { describe, expect, it } from "vitest";
import {
	type DeadCodeCandidate,
	findDeadCodeCandidates,
	formatDeadCodeCandidates,
	type SurvivorLike,
} from "./dead-code-signal.js";

const s = (id: string, line: number, mutatorName: string, replacement?: string): SurvivorLike => ({
	id,
	line,
	column: 0,
	endLine: line,
	endColumn: 10,
	mutatorName,
	...(replacement === undefined ? {} : { replacement }),
});

describe("findDeadCodeCandidates — positive (must fire)", () => {
	it("P1: flags a condition that survived forced both true and false", () => {
		// The check.ts:126 shape — `file.endsWith(".d.ts")` unreachable because an
		// earlier branch already matched, so neither polarity is observable.
		const hits = findDeadCodeCandidates([
			s("1", 126, "ConditionalExpression", "true"),
			s("2", 126, "ConditionalExpression", "false"),
		]);
		expect(hits.length).toBe(1);
		expect(hits[0]?.confidence).toBe("high");
		expect(hits[0]?.mutantIds).toEqual(["1", "2"]);
		expect(hits[0]?.reason).toContain("BOTH true and false");
	});

	it("P2: flags a line where three or more mutants all survived", () => {
		// The status.ts dead-store shape: an initializer overwritten before any
		// read, so every operator applied to it is unobservable.
		const hits = findDeadCodeCandidates([
			s("1", 88, "ObjectLiteral", "{}"),
			s("2", 88, "BooleanLiteral", "true"),
			s("3", 88, "StringLiteral", '""'),
		]);
		expect(hits.length).toBe(1);
		expect(hits[0]?.confidence).toBe("medium");
		expect(hits[0]?.reason).toContain("3 mutants survived");
	});

	it("P3: ranks high-confidence candidates before medium ones", () => {
		const hits = findDeadCodeCandidates([
			s("1", 10, "ObjectLiteral", "{}"),
			s("2", 10, "StringLiteral", '""'),
			s("3", 10, "ArrayDeclaration", "[]"),
			s("4", 99, "ConditionalExpression", "true"),
			s("5", 99, "ConditionalExpression", "false"),
		]);
		expect(hits.map((h: DeadCodeCandidate) => h.confidence)).toEqual(["high", "medium"]);
		expect(hits[0]?.line).toBe(99);
	});
});

describe("findDeadCodeCandidates — negative (must not fire)", () => {
	it("does not treat missing or non-boolean condition replacements as polarity evidence", () => {
		expect(findDeadCodeCandidates([s("1", 50, "ConditionalExpression"), s("2", 50, "ConditionalExpression", "someExpression")])).toEqual([]);
	});

	it("N1: an ordinary test gap is not reported", () => {
		// One survivor on a line is the common case: write a better assertion.
		expect(findDeadCodeCandidates([s("1", 42, "ArithmeticOperator", "a - b")])).toEqual([]);
	});

	it("N2: two survivors on a line stay below the inert threshold", () => {
		expect(
			findDeadCodeCandidates([s("1", 42, "StringLiteral", '""'), s("2", 42, "ArithmeticOperator", "/")]),
		).toEqual([]);
	});

	it("N3: only ONE polarity surviving is a test gap, not dead code", () => {
		// `if (true)` surviving alone means the false path is untested — a real,
		// fixable gap. Reporting it as dead code would send the agent to delete
		// working code.
		expect(findDeadCodeCandidates([s("1", 50, "ConditionalExpression", "true")])).toEqual([]);
	});

	it("N4: true/false from NON-condition mutators is not polarity evidence", () => {
		expect(
			findDeadCodeCandidates([
				s("1", 60, "ArithmeticOperator", "true"),
				s("2", 60, "ArrayDeclaration", "false"),
			]),
		).toEqual([]);
	});

	it("N5: no survivors yields nothing", () => {
		expect(findDeadCodeCandidates([])).toEqual([]);
	});
});

describe("formatDeadCodeCandidates", () => {
	it("P1: renders the candidate with a qualified review instruction", () => {
		const hits = findDeadCodeCandidates([
			s("1", 126, "ConditionalExpression", "true"),
			s("2", 126, "ConditionalExpression", "false"),
		]);
		const msg = formatDeadCodeCandidates("src/commands/check.ts", hits);
		expect(msg).toContain("src/commands/check.ts:126");
		expect(msg).toContain("[high]");
		expect(msg).toContain("Survivors alone do not prove dead code");
	});

	it("N1: returns null when there are no candidates", () => {
		expect(formatDeadCodeCandidates("src/a.ts", [])).toBeNull();
	});
});
