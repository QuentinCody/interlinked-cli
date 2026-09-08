import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
// Tests for the test-oracle diff checks. Everything drives the injectable
// OracleDiffDeps seam — no live git, no disk.

import { describe, expect, it } from "vitest";
import {
	checkAssertionCountRegression,
	checkAssertionValueSwap,
	checkTestBlockCountRegression,
	classifyTestBlockLoss,
	companionSourceCandidates,
	type OracleDiffDeps,
} from "./behavioral-diff-checks-oracle.js";
import type { SessionTrajectory } from "./types.js";

function session(files: string[]): SessionTrajectory {
	return { ...completeSessionFixture(), files_written: new Set(files) };
}

function deps(
	diffs: Record<string, string>,
	existing: string[] = ["everything"],
): OracleDiffDeps {
	return {
		stagedDiff: (f) => diffs[f] ?? "",
		sourceExists: (p) => existing.includes("everything") || existing.includes(p),
	};
}

const DEL_TWO_TESTS = [
	"--- a/src/foo.test.ts",
	"+++ b/src/foo.test.ts",
	"-it('a', () => { expect(f(1)).toBe(2); });",
	"-it('b', () => { expect(f(2)).toBe(3); });",
].join("\n");

describe("checkTestBlockCountRegression — SUT-conditioned", () => {
	it("ERROR on unexplained loss: SUT alive, commit net negative, no .each", () => {
		const s = session(["/r/src/foo.test.ts"]);
		const out = checkTestBlockCountRegression(s, deps({ "/r/src/foo.test.ts": DEL_TWO_TESTS }));
		expect(out).toHaveLength(1);
		expect(out[0]?.severity).toBe("error");
		expect(out[0]?.message).toContain("removed 2 more test block(s)");
	});

	it("INFO cascade when the companion SUT no longer exists", () => {
		const s = session(["/r/src/foo.test.ts"]);
		const out = checkTestBlockCountRegression(
			s,
			deps({ "/r/src/foo.test.ts": DEL_TWO_TESTS }, []),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.severity).toBe("info");
		expect(out[0]?.message).toContain("deletion cascade");
	});

	it("INFO move when sibling test files gain at least as much", () => {
		const gain = [
			"+it('a', () => { expect(g(1)).toBe(2); });",
			"+it('b', () => { expect(g(2)).toBe(3); });",
			"+it('c', () => { expect(g(3)).toBe(4); });",
		].join("\n");
		const s = session(["/r/src/foo.test.ts", "/r/src/bar.test.ts"]);
		const out = checkTestBlockCountRegression(
			s,
			deps({ "/r/src/foo.test.ts": DEL_TWO_TESTS, "/r/src/bar.test.ts": gain }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.severity).toBe("info");
		expect(out[0]?.message).toContain("move");
	});

	it("INFO consolidation when an it.each table is introduced in the same diff", () => {
		const consolidated = `${DEL_TWO_TESTS}\n+it.each([[1,2],[2,3]])('f(%i)', (a, b) => { expect(f(a)).toBe(b); });`;
		const s = session(["/r/src/foo.test.ts"]);
		const out = checkTestBlockCountRegression(
			s,
			deps({ "/r/src/foo.test.ts": consolidated }),
		);
		// net is -2 +1 = -1 → still a loss, but explained by the .each table.
		expect(out).toHaveLength(1);
		expect(out[0]?.severity).toBe("info");
		expect(out[0]?.message).toContain("consolidation");
	});

	it("silent when nothing was lost", () => {
		const s = session(["/r/src/foo.test.ts"]);
		const add = "+it('new', () => { expect(1).toBe(1); });";
		expect(checkTestBlockCountRegression(s, deps({ "/r/src/foo.test.ts": add }))).toEqual([]);
	});

	it("classifyTestBlockLoss is exported for the history replay", () => {
		const d = { file: "/r/x.test.ts", plus: 0, minus: 1, net: -1, addedEachTable: false };
		expect(classifyTestBlockLoss(d, -1, deps({}, []))).toBe("cascade");
		expect(classifyTestBlockLoss(d, 0, deps({}))).toBe("move");
		expect(classifyTestBlockLoss({ ...d, addedEachTable: true }, -1, deps({}))).toBe(
			"each_table",
		);
		expect(classifyTestBlockLoss(d, -1, deps({}))).toBe("unexplained");
	});

	it("INFO sut_shrank when the companion source also net-shrank (removed behavior)", () => {
		// Replay case 496834f: a dropped false-positive signal took -73 source
		// lines and its 6 tests together — the companion's diff is net-negative.
		const d = { file: "/r/src/x.test.ts", plus: 0, minus: 6, net: -6, addedEachTable: false };
		const sutShrinking = deps(
			{ "/r/src/x.ts": "-gone1\n-gone2\n-gone3\n+kept" },
			["/r/src/x.ts"],
		);
		expect(classifyTestBlockLoss(d, -6, sutShrinking)).toBe("sut_shrank");
		// A companion that GREW does not explain deleted tests.
		const sutGrowing = deps({ "/r/src/x.ts": "+new1\n+new2" }, ["/r/src/x.ts"]);
		expect(classifyTestBlockLoss(d, -6, sutGrowing)).toBe("unexplained");
	});

	it("INFO declared_test_maintenance on a test:-typed commit (replay case faeb551)", () => {
		const d = { file: "/r/src/x.test.ts", plus: 0, minus: 1, net: -1, addedEachTable: false };
		const unchanged = deps({ "/r/src/x.ts": "" }, ["/r/src/x.ts"]);
		expect(classifyTestBlockLoss(d, -1, unchanged, "test")).toBe("declared_test_maintenance");
		expect(classifyTestBlockLoss(d, -1, unchanged, "fix")).toBe("unexplained");
	});
});

describe("companionSourceCandidates", () => {
	it("maps sibling and __tests__ conventions across JS/TS extensions", () => {
		const sibling = companionSourceCandidates("/r/src/foo.test.ts");
		expect(sibling).toContain("/r/src/foo.ts");
		expect(sibling).toContain("/r/src/foo.tsx");
		const dunder = companionSourceCandidates("/r/src/__tests__/foo.test.ts");
		expect(dunder).toContain("/r/src/foo.ts");
	});
});

describe("checkAssertionCountRegression", () => {
	it("warns when test assertions net-drop while source changed", () => {
		const s = session(["/r/src/foo.test.ts", "/r/src/foo.ts"]);
		const out = checkAssertionCountRegression(
			s,
			deps({
				"/r/src/foo.test.ts": "-  expect(f(1)).toBe(2);\n-  expect(f(2)).toBe(3);",
				"/r/src/foo.ts": "+export const x = 1;",
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.severity).toBe("warning");
		expect(out[0]?.message).toContain("net-removed 2 assertion(s)");
	});

	it("silent when assertions grew, or only tests changed", () => {
		const s = session(["/r/src/foo.test.ts", "/r/src/foo.ts"]);
		expect(
			checkAssertionCountRegression(
				s,
				deps({
					"/r/src/foo.test.ts": "+  expect(f(1)).toBe(2);",
					"/r/src/foo.ts": "+export const x = 1;",
				}),
			),
		).toEqual([]);
		const testsOnly = session(["/r/src/foo.test.ts"]);
		expect(
			checkAssertionCountRegression(
				testsOnly,
				deps({ "/r/src/foo.test.ts": "-  expect(f(1)).toBe(2);" }),
			),
		).toEqual([]);
	});
});

describe("checkAssertionValueSwap", () => {
	it("flags same subject + matcher with a changed expected value (info)", () => {
		const s = session(["/r/src/foo.test.ts"]);
		const diff = ["-  expect(total(order)).toBe(5);", "+  expect(total(order)).toBe(6);"].join(
			"\n",
		);
		const out = checkAssertionValueSwap(s, deps({ "/r/src/foo.test.ts": diff }));
		expect(out).toHaveLength(1);
		expect(out[0]?.severity).toBe("info");
		expect(out[0]?.message).toContain("5");
		expect(out[0]?.message).toContain("6");
	});

	it("silent on unrelated add/remove pairs and non-value edits", () => {
		const s = session(["/r/src/foo.test.ts"]);
		const differentSubject = ["-  expect(a(x)).toBe(1);", "+  expect(b(x)).toBe(1);"].join("\n");
		expect(checkAssertionValueSwap(s, deps({ "/r/src/foo.test.ts": differentSubject }))).toEqual(
			[],
		);
		const sameValue = ["-  expect(a(x)).toBe(1);", "+  expect(a(x)).toBe(1);"].join("\n");
		expect(checkAssertionValueSwap(s, deps({ "/r/src/foo.test.ts": sameValue }))).toEqual([]);
	});

	it("caps at 3 findings per file", () => {
		const lines: string[] = [];
		for (let i = 0; i < 6; i++) {
			lines.push(`-  expect(f${i}(x)).toBe(${i});`, `+  expect(f${i}(x)).toBe(${i + 1});`);
		}
		const s = session(["/r/src/foo.test.ts"]);
		const out = checkAssertionValueSwap(s, deps({ "/r/src/foo.test.ts": lines.join("\n") }));
		expect(out).toHaveLength(3);
	});
});

// ===========================================
// Mutant-kill supplement — targets the surviving-mutant sweep on this file.
// Each test names the branch/regex it isolates so a future reader can see
// why the input was shaped the way it was.
// ===========================================

describe("checkTestBlockCountRegression — diff-header exclusion and regex precision", () => {
	it("diff header lines ('+++'/'---') that happen to look like test blocks are not counted", () => {
		const diff = ["+++ it('h1', () => {});", "+++ it('h2', () => {});", "-it('real', () => {});"].join(
			"\n",
		);
		const out = checkTestBlockCountRegression(
			session(["/r/src/a.test.ts"]),
			deps({ "/r/src/a.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.severity).toBe("error");
		expect(out[0]?.message).toContain("(-1, +0)");
	});

	it("a '---' diff header line that happens to look like a test block is not counted (startsWith, not endsWith)", () => {
		const diff = ["--- it('h1', () => {});", "-it('real', () => {});"].join("\n");
		const out = checkTestBlockCountRegression(
			session(["/r/src/dash.test.ts"]),
			deps({ "/r/src/dash.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("(-1, +0)");
	});

	it("an added '+' line that doesn't match the test-block regex is not counted toward plus", () => {
		const diff = "+not-a-test-line\n-it('real', () => {});";
		const out = checkTestBlockCountRegression(
			session(["/r/src/b.test.ts"]),
			deps({ "/r/src/b.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("(-1, +0)");
	});

	it("only files matching TEST_FILE_RE are scanned for block loss", () => {
		const out = checkTestBlockCountRegression(
			session(["/r/src/c.ts", "/r/src/c.test.ts"]),
			deps({
				"/r/src/c.ts": "-it('a', () => {});\n-it('b', () => {});",
				"/r/src/c.test.ts": DEL_TWO_TESTS,
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.file).toBe("/r/src/c.test.ts");
	});

	it("EACH_TABLE_RE match inside a '+++' header line does not count as case consolidation", () => {
		const diff = `${DEL_TWO_TESTS}\n+++ it.each([[1,2],[2,3]])('f(%i)', (a,b) => { expect(f(a)).toBe(b); });`;
		const out = checkTestBlockCountRegression(
			session(["/r/src/foo.test.ts"]),
			deps({ "/r/src/foo.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.severity).toBe("error");
		expect(out[0]?.message).not.toContain("reads as case consolidation");
	});

	it("TEST_BLOCK_INTRO_RE: recognizes a valid modifier, rejects an unknown modifier and a bare prefix", () => {
		const diff = [
			"--- a/foo.test.ts",
			"+++ b/foo.test.ts",
			"-it.skip('a', () => {});",
			"-it.bogus('b', () => {});",
			"-itSomething('c', () => {});",
		].join("\n");
		const out = checkTestBlockCountRegression(
			session(["/r/src/foo.test.ts"]),
			deps({ "/r/src/foo.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("(-1, +0)");
	});

	it("TEST_BLOCK_INTRO_RE: each modifier alternative is required for a quoted .each(...) intro to count", () => {
		const diff = [
			"-it.each('a')('x', fn);",
			"-it.only('b')('y', fn);",
			"-it.concurrent('c')('z', fn);",
			"-it.skipIf('d')('w', fn);",
			"-it.runIf('e')('v', fn);",
		].join("\n");
		const out = checkTestBlockCountRegression(
			session(["/r/src/mod.test.ts"]),
			deps({ "/r/src/mod.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("(-5, +0)");
	});

	it("TEST_BLOCK_INTRO_RE tolerates whitespace before the opening paren", () => {
		const diff = "-it ('a', () => {});\n-it('b', () => {});";
		const out = checkTestBlockCountRegression(
			session(["/r/src/space1.test.ts"]),
			deps({ "/r/src/space1.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("(-2, +0)");
	});

	it("TEST_BLOCK_INTRO_RE tolerates whitespace between the opening paren and the quote", () => {
		const diff = "-it( 'a', () => {});\n-it('b', () => {});";
		const out = checkTestBlockCountRegression(
			session(["/r/src/space2.test.ts"]),
			deps({ "/r/src/space2.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("(-2, +0)");
	});

	it("EACH_TABLE_RE tolerates whitespace between 'each' and its opening paren", () => {
		const consolidated = `${DEL_TWO_TESTS}\n+it.each ([[1,2],[2,3]])('f(%i)', (a, b) => { expect(f(a)).toBe(b); });`;
		const s = session(["/r/src/foospace.test.ts"]);
		const out = checkTestBlockCountRegression(s, deps({ "/r/src/foospace.test.ts": consolidated }));
		expect(out).toHaveLength(1);
		expect(out[0]?.severity).toBe("info");
		expect(out[0]?.message).toContain("consolidation");
	});

	it("EACH_TABLE_RE requires an actual call/template invocation, not a bare property reference", () => {
		const diff = ["-it('a', () => {});", "-it('b', () => {});", "+const ref = it.each;"].join("\n");
		const out = checkTestBlockCountRegression(
			session(["/r/src/foo.test.ts"]),
			deps({ "/r/src/foo.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.severity).toBe("error");
		expect(out[0]?.message).not.toContain("reads as case consolidation");
	});

	it("boundary: net exactly zero does not regress ('>=' not '>')", () => {
		const diff = "+it('a', () => {});\n-it('b', () => {});";
		const out = checkTestBlockCountRegression(
			session(["/r/src/bal.test.ts"]),
			deps({ "/r/src/bal.test.ts": diff }),
		);
		expect(out).toEqual([]);
	});

	it("uses the real DEFAULT_DEPS (git-backed) when no deps override is passed, without throwing", () => {
		const s = session(["/nonexistent-dir-xyz/ghost.test.ts"]);
		expect(() => checkTestBlockCountRegression(s)).not.toThrow();
		expect(checkTestBlockCountRegression(s)).toEqual([]);
	});
});

describe("checkTestBlockCountRegression — exact result shape (kills literal/string mutants)", () => {
	it("unexplained (error) result matches exactly", () => {
		const out = checkTestBlockCountRegression(
			session(["/r/src/foo.test.ts"]),
			deps({ "/r/src/foo.test.ts": DEL_TWO_TESTS }),
		);
		expect(out).toStrictEqual([
			{
				source: "structural",
				name: "test_block_count_regression",
				severity: "error",
				message:
					'foo.test.ts removed 2 more test block(s) than it added (-2, +0) while its SUT still exists and no sibling gains or .each consolidation explain it. If a test is wrong, fix it; don\'t drop coverage to make the suite pass. ("0 tests skipped or deleted" — the Bun merge bar.)',
				file: "/r/src/foo.test.ts",
				determinism: "fully_deterministic",
			},
		]);
	});

	it("move (info) result matches exactly, including the negated count", () => {
		const gain = [
			"+it('a', () => { expect(g(1)).toBe(2); });",
			"+it('b', () => { expect(g(2)).toBe(3); });",
			"+it('c', () => { expect(g(3)).toBe(4); });",
		].join("\n");
		const out = checkTestBlockCountRegression(
			session(["/r/src/foo.test.ts", "/r/src/bar.test.ts"]),
			deps({ "/r/src/foo.test.ts": DEL_TWO_TESTS, "/r/src/bar.test.ts": gain }),
		);
		expect(out).toStrictEqual([
			{
				source: "structural",
				name: "test_block_count_regression",
				severity: "info",
				message:
					"foo.test.ts removed 2 test block(s): net test-block loss here is offset by gains in sibling test files this commit — reads as a move, not a deletion.",
				file: "/r/src/foo.test.ts",
				determinism: "heuristic",
			},
		]);
	});

	it("sut_shrank (info) result matches exactly", () => {
		const out = checkTestBlockCountRegression(
			session(["/r/src/x.test.ts"]),
			deps({ "/r/src/x.test.ts": DEL_TWO_TESTS, "/r/src/x.ts": "-gone1\n-gone2\n-gone3\n+kept" }, [
				"/r/src/x.ts",
			]),
		);
		expect(out).toStrictEqual([
			{
				source: "structural",
				name: "test_block_count_regression",
				severity: "info",
				message:
					"x.test.ts removed 2 test block(s): the companion source also net-shrank in this commit — reads as tests following deliberately removed behavior. Confirm the removal was intended.",
				file: "/r/src/x.test.ts",
				determinism: "heuristic",
			},
		]);
	});

	it("declared_test_maintenance (info) result matches exactly", () => {
		const out = checkTestBlockCountRegression(
			session(["/r/src/x.test.ts"]),
			deps({ "/r/src/x.test.ts": DEL_TWO_TESTS, "/r/src/x.ts": "" }, ["/r/src/x.ts"]),
			"test",
		);
		expect(out).toStrictEqual([
			{
				source: "structural",
				name: "test_block_count_regression",
				severity: "info",
				message:
					"x.test.ts removed 2 test block(s): this commit is test:-typed — declared test maintenance. Deleting a weak test is oracle improvement; the declaration is auditable in the message.",
				file: "/r/src/x.test.ts",
				determinism: "heuristic",
			},
		]);
	});
});

describe("companionSourceCandidates — exact set and regex boundaries", () => {
	it("produces the exact 8-extension candidate list, in order, for a plain sibling file", () => {
		const out = companionSourceCandidates("/r/src/foo.test.ts");
		expect(out).toStrictEqual([
			"/r/src/foo.ts",
			"/r/src/foo.tsx",
			"/r/src/foo.js",
			"/r/src/foo.jsx",
			"/r/src/foo.mjs",
			"/r/src/foo.cjs",
			"/r/src/foo.mts",
			"/r/src/foo.cts",
		]);
	});

	it("strips only the trailing extension, not an earlier dot segment, from a multi-dot filename", () => {
		const out = companionSourceCandidates("/r/src/foo.util.test.ts");
		expect(out).toContain("/r/src/foo.util.ts");
		expect(out).not.toContain("/r/src/foo.ts.ts");
	});

	it("does not treat a dir that merely starts with '__tests__' as the __tests__ convention", () => {
		const out = companionSourceCandidates("/r/src/__tests__extra/foo.test.ts");
		expect(out).not.toContain("/r/src/foo.ts");
		expect(out).toContain("/r/src/__tests__extra/foo.ts");
	});

	it("recognizes a root-level __tests__ dir with no parent path segment", () => {
		const out = companionSourceCandidates("__tests__/foo.test.ts");
		expect(out).toContain("foo.ts");
	});
});

describe("classifyTestBlockLoss — companion-diff counting precision", () => {
	it("splits the companion diff by line, not by character (line130)", () => {
		// Each repeated segment nets -1 by line ("-a+b+c+d" is one removed line)
		// but would net +10 if the diff were iterated character-by-character
		// (5 '-' chars vs 15 '+' chars).
		const companionDiff = Array(5).fill("-a+b+c+d").join("\n");
		const d = { file: "/r/src/z.test.ts", plus: 0, minus: 1, net: -1, addedEachTable: false };
		expect(
			classifyTestBlockLoss(d, -1, deps({ "/r/src/z.ts": companionDiff }, ["/r/src/z.ts"])),
		).toBe("sut_shrank");
	});

	it("skips '+++' companion-diff header lines even when only that header would leak (headers-only leak)", () => {
		// Correct: '-realminus' -> minus=1; both '+++' lines are headers -> net=-1 -> sut_shrank.
		// If '+++' header-skip breaks, both leak in as '+' lines -> net=+1 -> unexplained.
		const companionDiff = "-realminus\n+++ fake1\n+++ fake2";
		const d = { file: "/r/src/j.test.ts", plus: 0, minus: 1, net: -1, addedEachTable: false };
		expect(
			classifyTestBlockLoss(d, -1, deps({ "/r/src/j.ts": companionDiff }, ["/r/src/j.ts"])),
		).toBe("sut_shrank");
	});

	it("skips '---' companion-diff header lines even when only that header would leak (headers-only leak)", () => {
		// Correct: '+realplus' -> plus=1; both '---' lines are headers -> net=+1 -> unexplained.
		// If '---' header-skip breaks, both leak in as '-' lines -> net=-1 -> sut_shrank.
		const companionDiff = "+realplus\n--- fake1\n--- fake2";
		const d = { file: "/r/src/k.test.ts", plus: 0, minus: 1, net: -1, addedEachTable: false };
		expect(
			classifyTestBlockLoss(d, -1, deps({ "/r/src/k.ts": companionDiff }, ["/r/src/k.ts"])),
		).toBe("unexplained");
	});

	it("counts '+' lines toward plus and unprefixed context lines toward neither (132/133)", () => {
		// Correct: plus=5 (real '+' lines), minus=1 (real '-' line), 6 neutral
		// context lines counted toward neither -> net=+4 -> unexplained.
		// If plus-counting breaks: plus=0 -> net=-1 -> sut_shrank.
		// If the minus branch becomes unconditional: the 6 context lines leak
		// into minus too -> net=5-7=-2 -> sut_shrank.
		const companionDiff = [
			"+p0",
			"+p1",
			"+p2",
			"+p3",
			"+p4",
			"-m0",
			"ctx0",
			"ctx1",
			"ctx2",
			"ctx3",
			"ctx4",
			"ctx5",
		].join("\n");
		const d = { file: "/r/src/m.test.ts", plus: 0, minus: 1, net: -1, addedEachTable: false };
		expect(
			classifyTestBlockLoss(d, -1, deps({ "/r/src/m.ts": companionDiff }, ["/r/src/m.ts"])),
		).toBe("unexplained");
	});
});

describe("checkAssertionCountRegression — precision supplement", () => {
	it("full warning result matches exactly (kills sampleFile-init and literal mutants)", () => {
		const out = checkAssertionCountRegression(
			session(["/r/src/foo.test.ts", "/r/src/foo.ts"]),
			deps({
				"/r/src/foo.test.ts": "-  expect(f(1)).toBe(2);\n-  expect(f(2)).toBe(3);",
				"/r/src/foo.ts": "+export const x = 1;",
			}),
		);
		expect(out).toStrictEqual([
			{
				source: "structural",
				name: "assertion_count_regression",
				severity: "warning",
				message:
					"staged test files net-removed 2 assertion(s) (+0/-2) while production source changed. A deleted expect() weakens the oracle exactly when it should tighten — restore the assertion or say why the behavior no longer holds.",
				file: "/r/src/foo.test.ts",
				determinism: "heuristic",
			},
		]);
	});

	it("a file with an empty (unchanged) diff does not falsely mark source as changed", () => {
		const out = checkAssertionCountRegression(
			session(["/r/src/foo.test.ts", "/r/src/ghost.ts"]),
			deps({ "/r/src/foo.test.ts": "-  expect(f(1)).toBe(2);" }),
		);
		expect(out).toEqual([]);
	});

	it("diff header lines that look like expect() calls are excluded from the count", () => {
		const diff = [
			"+++ expect(fake1).toBe(1);",
			"+++ expect(fake2).toBe(1);",
			"-  expect(real).toBe(1);",
		].join("\n");
		const out = checkAssertionCountRegression(
			session(["/r/src/foo.test.ts", "/r/src/foo.ts"]),
			deps({ "/r/src/foo.test.ts": diff, "/r/src/foo.ts": "+export const z = 1;" }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("net-removed 1 assertion(s) (+0/-1)");
	});

	it("a '---' diff header line that looks like an expect() call is excluded (startsWith, not endsWith)", () => {
		const diff = ["--- expect(fake).toBe(1);", "-  expect(real).toBe(1);"].join("\n");
		const out = checkAssertionCountRegression(
			session(["/r/src/foo.test.ts", "/r/src/foo.ts"]),
			deps({ "/r/src/foo.test.ts": diff, "/r/src/foo.ts": "+export const z = 1;" }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("net-removed 1 assertion(s) (+0/-1)");
	});

	it("unprefixed context lines are not counted as removed assertions (132/133 analog)", () => {
		const plusLines = Array.from({ length: 5 }, (_, i) => `+  expect(fp(${i})).toBe(${i});`);
		const neutralLines = Array.from({ length: 6 }, (_, i) => `   expect(fn(${i})).toBe(${i});`);
		const diff = [...plusLines, "-  expect(fm(1)).toBe(1);", ...neutralLines].join("\n");
		const out = checkAssertionCountRegression(
			session(["/r/src/foo.test.ts", "/r/src/foo.ts"]),
			deps({ "/r/src/foo.test.ts": diff, "/r/src/foo.ts": "+export const z = 1;" }),
		);
		expect(out).toEqual([]);
	});

	it("boundary: net exactly zero stays silent ('>=' not '>')", () => {
		const out = checkAssertionCountRegression(
			session(["/r/src/foo.test.ts", "/r/src/foo.ts"]),
			deps({
				"/r/src/foo.test.ts": "+  expect(a).toBe(1);\n-  expect(b).toBe(1);",
				"/r/src/foo.ts": "+export const z = 1;",
			}),
		);
		expect(out).toEqual([]);
	});
});

describe("checkAssertionValueSwap — precision supplement", () => {
	it("only scans files matching TEST_FILE_RE", () => {
		const diff = ["-  expect(total(order)).toBe(5);", "+  expect(total(order)).toBe(6);"].join("\n");
		const out = checkAssertionValueSwap(session(["/r/src/foo.ts"]), deps({ "/r/src/foo.ts": diff }));
		expect(out).toEqual([]);
	});

	it("a different matcher on the same subject is not misread as a value swap (key includes matcher)", () => {
		const diff = ["-  expect(x).toBe(5);", "+  expect(x).toEqual(6);"].join("\n");
		const out = checkAssertionValueSwap(
			session(["/r/src/foo.test.ts"]),
			deps({ "/r/src/foo.test.ts": diff }),
		);
		expect(out).toEqual([]);
	});

	it("subject whitespace inside expect(...) is trimmed before key matching", () => {
		const diff = ["-  expect( total(order) ).toBe(5);", "+  expect(total(order)).toBe(6);"].join(
			"\n",
		);
		const out = checkAssertionValueSwap(
			session(["/r/src/foo.test.ts"]),
			deps({ "/r/src/foo.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("(5 → 6)");
	});

	it("expected-value whitespace is trimmed so pure reformatting isn't flagged as a swap", () => {
		const diff = ["-  expect(x).toBe(5);", "+  expect(x).toBe( 5 );"].join("\n");
		const out = checkAssertionValueSwap(
			session(["/r/src/foo.test.ts"]),
			deps({ "/r/src/foo.test.ts": diff }),
		);
		expect(out).toEqual([]);
	});

	it("diff header lines that look like expect() calls do not pollute the swap comparison", () => {
		const diff = [
			"+++ expect(total(order)).toBe(999);",
			"-  expect(total(order)).toBe(5);",
			"+  expect(total(order)).toBe(6);",
		].join("\n");
		const out = checkAssertionValueSwap(
			session(["/r/src/foo.test.ts"]),
			deps({ "/r/src/foo.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("(5 → 6)");
		expect(out[0]?.message).not.toContain("999");
	});

	it("a '---' diff header line that looks like an expect() call does not pollute the swap comparison (startsWith, not endsWith)", () => {
		const diff = [
			"--- expect(total(order)).toBe(999);",
			"-  expect(total(order)).toBe(5);",
			"+  expect(total(order)).toBe(6);",
		].join("\n");
		const out = checkAssertionValueSwap(
			session(["/r/src/foo.test.ts"]),
			deps({ "/r/src/foo.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("(5 → 6)");
		expect(out[0]?.message).not.toContain("999");
	});

	it("unprefixed (unchanged) context lines do not get counted as additions", () => {
		const diff = [
			"-  expect(total(order)).toBe(5);",
			"+  expect(total(order)).toBe(6);",
			"   expect(total(order)).toBe(777);",
		].join("\n");
		const out = checkAssertionValueSwap(
			session(["/r/src/foo.test.ts"]),
			deps({ "/r/src/foo.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("(5 → 6)");
		expect(out[0]?.message).not.toContain("777");
	});

	it("flags when only SOME after-values are new, not just when ALL of them are (some, not every)", () => {
		const diff = [
			"-  expect(x).toBe(5);",
			"-  expect(x).toBe(6);",
			"+  expect(x).toBe(5);",
			"+  expect(x).toBe(7);",
		].join("\n");
		const out = checkAssertionValueSwap(
			session(["/r/src/foo.test.ts"]),
			deps({ "/r/src/foo.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("7");
	});

	it("message subject/matcher are parsed from the '|'-joined key, not a per-character split", () => {
		const diff = ["-  expect(total(order)).toBe(5);", "+  expect(total(order)).toBe(6);"].join("\n");
		const out = checkAssertionValueSwap(
			session(["/r/src/foo.test.ts"]),
			deps({ "/r/src/foo.test.ts": diff }),
		);
		expect(out[0]?.message).toContain("expect(total(order)).toBe(…)");
	});

	it("full result object matches exactly", () => {
		const diff = ["-  expect(total(order)).toBe(5);", "+  expect(total(order)).toBe(6);"].join("\n");
		const out = checkAssertionValueSwap(
			session(["/r/src/foo.test.ts"]),
			deps({ "/r/src/foo.test.ts": diff }),
		);
		expect(out).toStrictEqual([
			{
				source: "structural",
				name: "assertion_value_swap",
				severity: "info",
				message:
					"foo.test.ts: expect(total(order)).toBe(…) expected value changed in this diff (5 → 6). Legitimate if the spec changed — confirm the new value is specified, not observed.",
				file: "/r/src/foo.test.ts",
				determinism: "heuristic",
			},
		]);
	});

	it("EXPECT_CALL_RE allows whitespace after 'expect' before the subject paren", () => {
		const diff = ["-  expect (x).toBe(5);", "+  expect (x).toBe(6);"].join("\n");
		const out = checkAssertionValueSwap(
			session(["/r/src/foo.test.ts"]),
			deps({ "/r/src/foo.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
	});

	it("EXPECT_CALL_RE allows whitespace before the dot", () => {
		const diff = ["-  expect(x) .toBe(5);", "+  expect(x) .toBe(6);"].join("\n");
		const out = checkAssertionValueSwap(
			session(["/r/src/foo.test.ts"]),
			deps({ "/r/src/foo.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
	});

	it("EXPECT_CALL_RE allows whitespace after the dot", () => {
		const diff = ["-  expect(x). toBe(5);", "+  expect(x). toBe(6);"].join("\n");
		const out = checkAssertionValueSwap(
			session(["/r/src/foo.test.ts"]),
			deps({ "/r/src/foo.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
	});

	it("EXPECT_CALL_RE allows whitespace before the matcher's args paren", () => {
		const diff = ["-  expect(x).toBe (5);", "+  expect(x).toBe (6);"].join("\n");
		const out = checkAssertionValueSwap(
			session(["/r/src/foo.test.ts"]),
			deps({ "/r/src/foo.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
	});

	it("EXPECT_CALL_RE captures a multi-character arg (not collapsed to a single atom)", () => {
		const diff = ["-  expect(x).toBe(55);", "+  expect(x).toBe(66);"].join("\n");
		const out = checkAssertionValueSwap(
			session(["/r/src/foo.test.ts"]),
			deps({ "/r/src/foo.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("55");
		expect(out[0]?.message).toContain("66");
	});

	it("EXPECT_CALL_RE captures a nested single-level-paren arg with multi-char inner content", () => {
		const diff = ["-  expect(x).toBe(total(order));", "+  expect(x).toBe(total(item));"].join("\n");
		const out = checkAssertionValueSwap(
			session(["/r/src/foo.test.ts"]),
			deps({ "/r/src/foo.test.ts": diff }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("total(order)");
		expect(out[0]?.message).toContain("total(item)");
	});
});
