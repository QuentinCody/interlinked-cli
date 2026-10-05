// Pins for the kill-evidence classifier (antithesis intake §7 step 5). The
// reason texts are copied from a real Stryker report
// (`reports/mutation/mutation.json`: 84 mutants, 82 killed, 82/82 with
// `statusReason` and `killedBy`).
import { describe, expect, it } from "vitest";
import { classifyKill, firstReasonLine, killEvidenceOf, REASON_MAX_CHARS } from "./kill-class.js";

const report = (mutants: unknown[], testFiles: Record<string, unknown> = {}) => ({
	files: { "src/a.ts": { mutants } },
	testFiles,
});
const TEST_FILES = {
	"src/a.test.ts": { tests: [{ id: "0", name: "a" }, { id: "1", name: "b" }] },
	"src/a.mutation-kill.test.ts": { tests: [{ id: "2", name: "c" }] },
	"src/dup-1.test.ts": { tests: [{ id: "9", name: "d" }] },
	"src/dup-2.test.ts": { tests: [{ id: "9", name: "e" }] },
};

describe("classifyKill — positive (must fire)", () => {
	it("P1: a runtime-error message is an exception kill", () => {
		expect(classifyKill("Killed", "Cannot read properties of null (reading 'old_string')")).toBe("exception");
		expect(classifyKill("Killed", "Cannot read properties of undefined (reading 'sort')")).toBe("exception");
		expect(classifyKill("Killed", "fn is not a function")).toBe("exception");
	});

	it("P2: vitest's matcher grammar is an assertion kill", () => {
		expect(classifyKill("Killed", "expected 1 to be 2 // Object.is equality")).toBe("assertion");
		expect(classifyKill("Killed", "expected null to deeply equal { ops: [ { kind: 'write', …(2) } ] }")).toBe("assertion");
		expect(classifyKill("Killed", "AssertionError: values differ")).toBe("assertion");
	});

	it("P3: a Timeout status is a timeout kill whatever its reason", () => {
		expect(classifyKill("Timeout", "expected 1 to be 2")).toBe("timeout");
		expect(classifyKill("Timeout", undefined)).toBe("timeout");
	});

	it("P5: the assertion library refusing a wrong-typed actual is an assertion kill", () => {
		const refusal = "the given combination of arguments (undefined and string) is invalid for this assertion. You can use an array";
		expect(classifyKill("Killed", refusal)).toBe("assertion");
		expect(classifyKill("Killed", ".toMatch() expects to receive a string, but got undefined")).toBe("assertion");
		expect(classifyKill("Killed", 'promise resolved "undefined" instead of rejecting')).toBe("assertion");
	});

	it("P6: Node and JSON runtime errors are exception kills", () => {
		expect(classifyKill("Killed", "ENOENT: no such file or directory, open '/tmp/x'")).toBe("exception");
		expect(classifyKill("Killed", "Unexpected end of JSON input")).toBe("exception");
		expect(classifyKill("Killed", 'The "path" argument must be of type string. Received undefined')).toBe("exception");
		expect(classifyKill("Killed", "Cannot convert undefined or null to object")).toBe("exception");
	});

	it("P4: an assertion that quotes a runtime error stays an assertion", () => {
		expect(classifyKill("Killed", "expected [Function] to throw error including 'is not a function'")).toBe("assertion");
	});
});

describe("classifyKill — negative (must not fire)", () => {
	it("N1: an empty or missing reason is unknown", () => {
		expect(classifyKill("Killed", "")).toBe("unknown");
		expect(classifyKill("Killed", undefined)).toBe("unknown");
		expect(classifyKill("Killed", 42)).toBe("unknown");
	});

	it("N2: an unrecognized message is unknown, never guessed into a bucket", () => {
		expect(classifyKill("Killed", "process exited with code 1")).toBe("unknown");
		expect(classifyKill("Killed", "TypeError")).toBe("unknown");
		// A project's own guard helper is not a portable vocabulary.
		expect(classifyKill("Killed", "nonNull: expected a value but received null/undefined")).toBe("unknown");
	});

	it("N3: statuses that are not kills classify as unknown", () => {
		expect(classifyKill("Survived", "expected 1 to be 2")).toBe("unknown");
		expect(classifyKill("NoCoverage", "Cannot read properties of null")).toBe("unknown");
	});

	it("N4: only the first line is read", () => {
		expect(classifyKill("Killed", "something else\nexpected 1 to be 2")).toBe("unknown");
	});
});

describe("firstReasonLine", () => {
	it("P1: trims and caps the first line", () => {
		expect(firstReasonLine("  expected 1 to be 2\n  at x")).toBe("expected 1 to be 2");
		const long = "x".repeat(REASON_MAX_CHARS + 5);
		expect(firstReasonLine(long)).toBe(`${"x".repeat(REASON_MAX_CHARS)}…`);
	});

	it("N1: no text gives null", () => {
		expect(firstReasonLine("   ")).toBeNull();
		expect(firstReasonLine(null)).toBeNull();
	});
});

describe("killEvidenceOf — positive (must fire)", () => {
	it("P1: a killed mutant yields its class, reason, killing file and tests completed", () => {
		const rows = killEvidenceOf(
			report([{ id: "1", status: "Killed", statusReason: "expected 1 to be 2", killedBy: ["1"], testsCompleted: 4 }], TEST_FILES),
		);
		expect(rows).toEqual([
			{
				file: "src/a.ts",
				mutantId: "1",
				status: "Killed",
				killClass: "assertion",
				reason: "expected 1 to be 2",
				killingTestFiles: ["src/a.test.ts"],
				unresolvedKillers: 0,
				mutationDirectedKiller: false,
				testsCompleted: 4,
			},
		]);
	});

	it("P2: a killer under a mutation-directed path is flagged as metadata", () => {
		const [row] = killEvidenceOf(report([{ id: "2", status: "Killed", statusReason: "x is not defined", killedBy: ["2"] }], TEST_FILES));
		expect(row?.mutationDirectedKiller).toBe(true);
		expect(row?.killClass).toBe("exception");
		expect(row?.testsCompleted).toBeNull();
	});

	it("P3: an ambiguous or unknown test id is counted unresolved, not guessed", () => {
		const [row] = killEvidenceOf(report([{ id: "3", status: "Timeout", killedBy: ["9", "77", "0"] }], TEST_FILES));
		expect(row?.killingTestFiles).toEqual(["src/a.test.ts"]);
		expect(row?.unresolvedKillers).toBe(2);
		expect(row?.killClass).toBe("timeout");
	});
});

describe("killEvidenceOf — negative (must not fire)", () => {
	it("N1: survivors, uncovered mutants and malformed entries yield no rows", () => {
		const rows = killEvidenceOf(
			report([{ id: "4", status: "Survived" }, { id: "5", status: "NoCoverage" }, null]),
		);
		expect(rows).toEqual([]);
	});

	it("N2: a non-report value yields no rows", () => {
		expect(killEvidenceOf(null)).toEqual([]);
		expect(killEvidenceOf({ files: [] })).toEqual([]);
	});
});
