// Unit tests for test-async-assertions.ts
//
// Covers:
//   Positive (MUST fire):
//     P1  statement-position expect(p).rejects.toThrow() with no await
//     P2  statement-position expect(p).resolves.toBe() with no await
//     P3  multi-line chain: expect(p) on one line, .rejects on the next
//     P4  bare .rejects chain after another awaited statement
//   Negative (MUST NOT fire):
//     N1  awaited form: await expect(p).rejects.toThrow()
//     N2  returned form: return expect(p).rejects.toThrow()
//     N3  void-prefixed form: void expect(p).rejects.toThrow()
//     N4  assigned to a variable that IS awaited later
//     N5  elements of an awaited Promise.all([...]) array
//     N6  plain sync assertion expect(x).toBe(1)
//     N7  non-test file — out of scope
//     N8  multi-line await expect( arg on next line ).rejects…

import { describe, expect, it } from "vitest";
import { detectUnawaitedAsyncAssertions } from "./test-async-assertions.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

const TEST_PATH = "src/lib/__tests__/thing.test.ts";

function fires(src: string, filePath: string = TEST_PATH): boolean {
	return detectUnawaitedAsyncAssertions(src, filePath).length > 0;
}

// ─── Positive cases ───────────────────────────────────────────────────────────

describe("detectUnawaitedAsyncAssertions — positive (must fire)", () => {
	it("P1: statement-position expect(p).rejects.toThrow() with no await", () => {
		const src = `
it("rejects on bad input", async () => {
  expect(doWork("bad")).rejects.toThrow("nope");
});
`;
		const found = detectUnawaitedAsyncAssertions(src, TEST_PATH);
		expect(found.length).toBe(1);
		expect(found[0]?.line).toBe(3);
		expect(found[0]?.text).toMatch(/unawaited_async_assertion/);
	});

	it("P2: statement-position expect(p).resolves.toBe() with no await", () => {
		const src = `
it("resolves to 1", async () => {
  expect(compute()).resolves.toBe(1);
});
`;
		expect(fires(src)).toBe(true);
	});

	it("P3: multi-line chain — expect(p) then .rejects on the next line", () => {
		const src = `
it("rejects", async () => {
  expect(doWork())
    .rejects.toThrow();
});
`;
		expect(fires(src)).toBe(true);
	});

	it("P4: floating .rejects chain after a preceding awaited statement", () => {
		const src = `
it("two assertions, second floats", async () => {
  await expect(first()).resolves.toBe(1);
  expect(second()).rejects.toThrow();
});
`;
		const found = detectUnawaitedAsyncAssertions(src, TEST_PATH);
		expect(found.length).toBe(1);
		expect(found[0]?.line).toBe(4);
	});

	it("caps results at 10 per file", () => {
		const body = Array.from({ length: 15 }, (_, i) =>
			`  expect(work${i}()).rejects.toThrow();`,
		).join("\n");
		const src = `it("many", async () => {\n${body}\n});\n`;
		expect(detectUnawaitedAsyncAssertions(src, TEST_PATH).length).toBe(10);
	});

	it("P5: floating chain as the very first line of the file — no previous line to check", () => {
		// previousSignificantLine(lines, 0) has nothing before index 0 and falls
		// back to null. If that fallback were instead some placeholder string
		// ending in a continuation token (e.g. a stray "="), the statement-
		// position gate would misread it as "this is a continuation" and
		// suppress the finding — so the line-1 match here proves the no-prior-
		// line case is treated as fresh statement position, not continuation.
		const src = 'expect(doWork()).rejects.toThrow();\n';
		const found = detectUnawaitedAsyncAssertions(src, TEST_PATH);
		expect(found.length).toBe(1);
		expect(found[0]?.line).toBe(1);
	});
});

// ─── Negative cases ───────────────────────────────────────────────────────────

describe("detectUnawaitedAsyncAssertions — negative (must NOT fire)", () => {
	it("N1: awaited form — should not fire", () => {
		const src = `
it("rejects", async () => {
  await expect(doWork("bad")).rejects.toThrow("nope");
});
`;
		expect(fires(src)).toBe(false);
	});

	it("N2: returned form — should not fire", () => {
		const src = `
it("rejects", () => {
  return expect(doWork("bad")).rejects.toThrow("nope");
});
`;
		expect(fires(src)).toBe(false);
	});

	it("N3: void-prefixed form — should not fire", () => {
		const src = `
it("fire-and-forget by explicit choice", async () => {
  void expect(doWork()).rejects.toThrow();
  await settle();
});
`;
		expect(fires(src)).toBe(false);
	});

	it("N4: chain assigned to a variable that IS awaited later — should not fire", () => {
		const src = `
it("collects then awaits", async () => {
  const assertion = expect(doWork()).rejects.toThrow();
  await triggerFailure();
  await assertion;
});
`;
		expect(fires(src)).toBe(false);
	});

	it("N5: chains as elements of an awaited Promise.all — should not fire", () => {
		const src = `
it("parallel assertions", async () => {
  await Promise.all([
    expect(a()).rejects.toThrow(),
    expect(b()).resolves.toBe(2),
  ]);
});
`;
		expect(fires(src)).toBe(false);
	});

	it("N6: plain synchronous assertion — should not fire", () => {
		const src = `
it("sync", () => {
  expect(add(1, 2)).toBe(3);
  expect(list).toEqual([1, 2]);
});
`;
		expect(fires(src)).toBe(false);
	});

	it("N7: non-test file — out of scope, should not fire", () => {
		const src = `expect(doWork()).rejects.toThrow();\n`;
		expect(fires(src, "src/lib/runtime.ts")).toBe(false);
	});

	it("N8: multi-line await expect( with argument on the next line — should not fire", () => {
		const src = `
it("rejects", async () => {
  await expect(
    doWork("bad"),
  ).rejects.toThrow();
});
`;
		expect(fires(src)).toBe(false);
	});

	it("N9: .rejects mentioned in a comment — should not fire", () => {
		const src = `
it("documented", async () => {
  // expect(doWork()).rejects.toThrow() would float here
  await expect(doWork()).rejects.toThrow();
});
`;
		expect(fires(src)).toBe(false);
	});

	it("N10: expect(...) call whose parens never balance before end of file — should not fire", () => {
		// skipBalancedParens scans from the opening "(" to end of file looking for
		// the matching close; an unterminated call never reaches depth 0 and falls
		// through to its -1 sentinel. The guard `afterClose === -1` bails before
		// reading a chain. A `.rejects` sequence sits at offset 0 of this fixture
		// on purpose: if the sentinel were ever a small non-negative offset
		// instead of -1, chainIsAsyncMatcher would slice from near the start of
		// the file, land on that `.rejects` text, and this test would flag a
		// finding that must not exist.
		const src = `.rejects.toThrow();
expect(doWork(`;
		expect(detectUnawaitedAsyncAssertions(src, TEST_PATH)).toEqual([]);
	});
});
