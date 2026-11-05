// Pins the human-facing wording and the pure option/exit helpers of
// `interlinked tests prove-kill` / `interlinked tests kill-proofs`. The proof
// engine itself is pinned in `src/harness/kill-proof/*.test.ts`.
import { describe, expect, it } from "vitest";
import type { KillProofReceipt, ProveKillResult, ResolvedMutant } from "../harness/kill-proof/types.js";
import { exitCodeFor, type KillProofRow, killProofsTally, PROVE_KILL_EXIT, renderKillProofs, renderProveKill, renewCommand, specFromOptions, timeoutProblem } from "./tests-prove-kill.js";

const MUTANT: ResolvedMutant = { file: "src/math.ts", offset: 10, originalLexeme: "return max;", replacement: "return value;", line: 3, source: "explicit" };

function receipt(verdict: KillProofReceipt["verdict"], cases: KillProofReceipt["underMutant"]["cases"]): KillProofReceipt {
	return {
		version: 1, id: "7113042096864a76", digest: "0".repeat(64), verdict, reasons: [], provedAt: "2026-11-04T00:00:00.000Z", root: "/repo",
		source: { path: "src/math.ts", sha256: "a" }, mutant: MUTANT, tests: [{ path: "test/clamp.test.ts", sha256: "b" }], boundImports: [], killedTests: [],
		baseline: { cases: cases.length, durationMs: 800 }, underMutant: { durationMs: 700, timedOut: false, cases },
		environment: { node: "v22.0.0", vitest: "4.0.0", platform: "linux", config: null, setupFiles: [], configFiles: [], unresolvable: [] },
	};
}

const ok = (verdict: KillProofReceipt["verdict"], cases: KillProofReceipt["underMutant"]["cases"]): ProveKillResult =>
	({ ok: true, receipt: receipt(verdict, cases), receiptPath: "/repo/.interlinked/test-runs/kill-proofs/7113042096864a76.json" });

const ROW: KillProofRow = { id: "7113042096864a76", verdict: "killed", provedAt: "2026-11-04T00:00:00.000Z", mutant: "explicit fault @ src/math.ts:3", tests: ["test/clamp.test.ts"], killedTests: ["test/clamp.test.ts"] };

describe("specFromOptions — positive (must accept)", () => {
	it("P1: an explicit fault with all three flags", () => {
		expect(specFromOptions({ file: "src/a.ts", find: "x", replace: "y" })).toEqual({ kind: "explicit", file: "src/a.ts", find: "x", replace: "y" });
	});
	it("P2: a manifest id, narrowed by --file", () => {
		expect(specFromOptions({ mutant: "575ddae6cc2946f9", file: "src/a.ts" })).toEqual({ kind: "manifest", mutantId: "575ddae6cc2946f9", file: "src/a.ts" });
	});
});

describe("specFromOptions — negative (must refuse)", () => {
	it("N1: a malformed --mutant names the id shape and where to find ids", () => {
		expect(specFromOptions({ mutant: "xyz" })).toBe("--mutant takes a 16-character hex mutant id; list them with `interlinked mutation survivors --file <path>`");
	});
	it("N2: no mutant at all points at --help", () => {
		expect(specFromOptions({})).toBe("name the mutant: --mutant <id>, or --file <src> --find <text> --replace <text>; see --help");
	});
	it("N3: --mutant together with --find is refused", () => {
		expect(specFromOptions({ mutant: "575ddae6cc2946f9", find: "x", replace: "y" })).toBe("pass either --mutant <id> or --file/--find/--replace, not both");
	});
	it("N4: an explicit fault missing --replace is refused", () => {
		expect(specFromOptions({ file: "src/a.ts", find: "x" })).toBe("an explicit fault needs all three of --file, --find and --replace");
	});
});

describe("exitCodeFor — positive (exit 0)", () => {
	it("P1: killed exits 0", () => {
		expect(exitCodeFor(ok("killed", [{ test: "t › a", verdict: "killed" }]))).toBe(PROVE_KILL_EXIT.proven);
	});
});

describe("exitCodeFor — negative (nonzero exit)", () => {
	it("N1: survived exits 1", () => {
		expect(exitCodeFor(ok("survived", [{ test: "t › a", verdict: "survived" }]))).toBe(1);
	});
	it("N2: not-passing-now exits 1", () => {
		expect(exitCodeFor({ ok: false, verdict: "not-passing-now", reasons: ["x"] })).toBe(1);
	});
	it("N3: inconclusive exits 2", () => {
		expect(exitCodeFor(ok("inconclusive", [{ test: "t › a", verdict: "inconclusive", reason: "TypeError" }]))).toBe(2);
	});
	it("N4: unavailable exits 2", () => {
		expect(exitCodeFor({ ok: false, verdict: "unavailable", reasons: ["x"] })).toBe(2);
	});
});

describe("renderProveKill — positive (decided verdicts)", () => {
	it("P1: killed lists cases, the receipt and how to keep it fresh", () => {
		const text = renderProveKill(ok("killed", [{ test: "test/clamp.test.ts › above", verdict: "killed" }]));
		expect(text).toContain("verdict: KILLED (700 ms under the mutant)");
		expect(text).toContain("  killed       test/clamp.test.ts › above");
		expect(text).toContain("receipt: /repo/.interlinked/test-runs/kill-proofs/7113042096864a76.json");
		expect(text.split("\n").at(-1)).toBe("Proof recorded. It holds while source, tests and runtime are unchanged; check with `interlinked tests kill-proofs --verify`.");
	});
	it("P2: survived says the tests still pass and what to assert", () => {
		const text = renderProveKill(ok("survived", [{ test: "test/weak.test.ts › number", verdict: "survived" }]));
		expect(text).toContain("verdict: SURVIVED");
		expect(text.split("\n").at(-1)).toBe("These tests still pass with the mutant applied. Strengthen the assertion: check the value the mutant changes, then re-run.");
	});
	it("P3: an inconclusive crash says nothing is proven and asks for an assertion", () => {
		const text = renderProveKill(ok("inconclusive", [{ test: "test/crash.test.ts › counts", verdict: "inconclusive", reason: "TypeError: x" }]));
		expect(text).toContain("  inconclusive test/crash.test.ts › counts — TypeError: x");
		expect(text.split("\n").at(-1)).toBe("Nothing is proven: a crash or load error is not a kill. Assert on the mutated code's result instead.");
	});
	it("P4: an inconclusive timeout names --run-timeout", () => {
		const result = ok("inconclusive", [{ test: "t › a", verdict: "inconclusive", reason: "runner timed out after 9 ms" }]);
		if (result.ok) result.receipt.underMutant.timedOut = true;
		expect(renderProveKill(result).split("\n").at(-1)).toBe("Nothing is proven: the mutant run timed out. Raise --run-timeout (default 300000), then re-run.");
	});
	it("P5: an inconclusive parse error asks for a replacement that compiles", () => {
		const result = ok("inconclusive", [{ test: "t › a", verdict: "inconclusive", reason: "the mutated src/math.ts does not parse (')' expected.); a compile error is not a kill" }]);
		if (result.ok) result.receipt.underMutant.error = "the mutated src/math.ts does not parse (')' expected.); a compile error is not a kill";
		expect(renderProveKill(result).split("\n").at(-1)).toBe("Nothing is proven: the mutated file does not parse. Pick a replacement that compiles, then re-run.");
	});
	it("P6: a non-repeatable kill asks the test to clean up its state", () => {
		const result = ok("inconclusive", [{ test: "t › a", verdict: "inconclusive", reason: "not repeatable: it also fails on a fresh unmutated copy (x). A run left state outside the copy" }]);
		expect(renderProveKill(result).split("\n").at(-1)).toBe("Nothing is proven: the test fails on a second clean run. Make it clean up the state it leaves.");
	});
});

describe("renderProveKill — negative (no receipt)", () => {
	it("N1: not-passing-now asks to fix the test first", () => {
		const text = renderProveKill({ ok: false, verdict: "not-passing-now", reasons: ["t › a: failed"], mutant: MUTANT });
		expect(text).toBe([
			'mutant: explicit fault @ src/math.ts:3 "return max;" → "return value;"',
			"verdict: NOT-PASSING-NOW",
			"  - t › a: failed",
			"Make the test pass on the current code first. A test that already fails proves nothing about the mutant.",
		].join("\n"));
	});
	it("N2: unavailable names the reason and says no receipt was written", () => {
		const text = renderProveKill({ ok: false, verdict: "unavailable", reasons: ["test/nope.test.ts does not exist"] });
		expect(text).toBe(["verdict: UNAVAILABLE", "  - test/nope.test.ts does not exist", "Fix the reason above and re-run. No receipt was written."].join("\n"));
	});
});

describe("renderKillProofs — positive (rows)", () => {
	it("P1: a verified stale row names its reasons", () => {
		const text = renderKillProofs([{ ...ROW, freshness: "stale", reasons: ["test test/clamp.test.ts changed since the proof"] }]);
		expect(text).toBe([
			"7113042096864a76 KILLED       2026-11-04T00:00:00.000Z explicit fault @ src/math.ts:3",
			"  tests: test/clamp.test.ts",
			"  STALE: test test/clamp.test.ts changed since the proof",
			"1 KILLED proof(s): 0 fresh, 0 uncommitted, 1 stale. Re-run the prove-kill command of each stale proof to renew it.",
		].join("\n"));
	});
	it("P1b: a verified fresh list ends with the tally", () => {
		const text = renderKillProofs([{ ...ROW, freshness: "fresh" }, { ...ROW, id: "b", verdict: "survived", killedTests: [], freshness: "fresh" }]);
		expect(text.split("\n").at(-1)).toBe("1 KILLED proof(s): 1 fresh, 0 uncommitted, 0 stale. Only KILLED proofs count as evidence.");
	});
	it("P2: an unverified row has no freshness line", () => {
		expect(renderKillProofs([ROW]).split("\n")).toHaveLength(2);
	});
});

describe("renderKillProofs — negative (nothing recorded)", () => {
	it("N1: the empty state says how to make a proof", () => {
		expect(renderKillProofs([])).toBe("No kill proofs recorded yet. Make one with `interlinked tests prove-kill --help`.");
	});
});

describe("renewCommand — positive (a receipt names its id and files)", () => {
	it("P1: a manifest receipt's renew command carries its mutant id and every named test file", () => {
		expect(renewCommand({ mutantId: "0123456789abcdef", tests: ["a.test.ts", "b.test.ts"] })).toBe("interlinked tests prove-kill --mutant 0123456789abcdef --test a.test.ts --test b.test.ts");
	});
});
describe("renewCommand — negative (nothing to fill in)", () => {
	it("N1: an explicit fault or an unreadable receipt keeps the nudge's placeholders", () => {
		expect(renewCommand({ tests: ["a.test.ts"] })).toBe("interlinked tests prove-kill --mutant <id> --test a.test.ts");
		expect(renewCommand({ tests: [] })).toBe("interlinked tests prove-kill --mutant <id> --test <file>");
	});
});
describe("killProofsTally — positive (verified rows)", () => {
	it("P1: counts KILLED receipts by freshness; unreadable counts as stale", () => {
		expect(killProofsTally([{ ...ROW, freshness: "fresh" }, { ...ROW, id: "b", freshness: "unreadable" }, { ...ROW, id: "c", freshness: "uncommitted" }, { ...ROW, id: "d", verdict: "survived", freshness: "stale" }]))
			.toBe("3 KILLED proof(s): 1 fresh, 1 uncommitted, 1 stale. Re-run the prove-kill command of each stale proof to renew it.");
	});
});
describe("killProofsTally — superseded receipts are history (verification af8b93d3 §6)", () => {
	it("P1: a superseded killed receipt is counted as `superseded`, never as stale, and the renew hint is not raised for it", () => {
		expect(killProofsTally([{ ...ROW, freshness: "uncommitted" }, { ...ROW, id: "b", freshness: "stale", supersededBy: ROW.id, reasons: ["source src/math.ts changed since the proof"] }]))
			.toBe("2 KILLED proof(s): 0 fresh, 1 uncommitted, 0 stale, 1 superseded. Only KILLED proofs count as evidence.");
	});
	it("P2: a tally with no superseded receipt keeps its shape", () => {
		expect(killProofsTally([{ ...ROW, freshness: "fresh" }])).toBe("1 KILLED proof(s): 1 fresh, 0 uncommitted, 0 stale. Only KILLED proofs count as evidence.");
	});
});
describe("killProofsTally — negative (unverified rows)", () => {
	it("N1: rows without a freshness have no tally", () => {
		expect(killProofsTally([ROW])).toBeNull();
	});
});

describe("timeoutProblem — --timeout / --run-timeout validation (kill-proof review round 4, M7)", () => {
	it("P1: both flags absent, or positive integers, are accepted", () => {
		expect(timeoutProblem({})).toBeNull();
		expect(timeoutProblem({ runTimeout: "300000", timeout: "600000" })).toBeNull();
	});
	it("N1: a non-numeric or non-positive value is a usage error naming the flag", () => {
		expect(timeoutProblem({ timeout: "soon" })).toBe("--timeout must be a positive number of milliseconds");
		expect(timeoutProblem({ timeout: "0" })).toBe("--timeout must be a positive number of milliseconds");
		expect(timeoutProblem({ runTimeout: "-5" })).toBe("--run-timeout must be a positive number of milliseconds");
	});
});

describe("renderProveKill — run-level warnings (kill-proof review round 4, M10)", () => {
	it("P1: a copy-size warning is printed after the mutant line and does not change the verdict or exit code", () => {
		const warned: ProveKillResult = { ...ok("killed", [{ test: "t › a", verdict: "killed" }]), warnings: ["[interlinked:kill-proof] copy is 400 MiB; large tracked files slow every proof"] };
		const text = renderProveKill(warned);
		expect(text.split("\n")[1]).toBe("warning: [interlinked:kill-proof] copy is 400 MiB; large tracked files slow every proof");
		expect(text).toContain("verdict: KILLED");
		expect(exitCodeFor(warned)).toBe(PROVE_KILL_EXIT.proven);
	});
});
