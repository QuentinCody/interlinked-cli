import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { checkMissingEffectCleanup } from "./missing-effect-cleanup.js";
import { __setPackageRootForTesting } from "./shared.js";

// `checkMissingEffectCleanup` gates on `isTestFile`, which (via
// `isHarnessInternalDataFile`) returns true for ANY path under the resolved
// interlinked-cli package root's `/harness/checks/` tree. To make the
// component-under-test fire deterministically, we pin the package root to a
// directory that none of our fixture paths live under, so the harness-internal
// exemption never matches our `/app/src/...` fixtures. We restore the real
// resolver (undefined → re-resolve) afterward.
beforeAll(() => {
	__setPackageRootForTesting("/nonexistent-pkg-root");
});
afterAll(() => {
	__setPackageRootForTesting(undefined);
});

// A .tsx component path that is NOT a test file and NOT under the pinned
// package root — so neither the strict-test nor the harness-internal exemption
// fires.
const TSX = "/app/src/components/Widget.tsx";
const JSX = "/app/src/components/Widget.jsx";

describe("checkMissingEffectCleanup — early-return gates", () => {
	it("returns [] for a test file (.test.tsx) regardless of content", () => {
		const code = [
			"useEffect(() => {",
			"  window.addEventListener('resize', onResize);",
			"}, []);",
		].join("\n");
		// `.test.tsx` matches the strict-test filename regex → isTestFile true.
		expect(checkMissingEffectCleanup(code, "/app/src/Widget.test.tsx")).toEqual([]);
	});

	it("returns [] for a path inside a __tests__/ directory", () => {
		const code = [
			"useEffect(() => {",
			"  el.addEventListener('click', h);",
			"}, []);",
		].join("\n");
		expect(checkMissingEffectCleanup(code, "/app/__tests__/Widget.tsx")).toEqual([]);
	});

	it("returns [] for a non-tsx/jsx extension (.ts) even with a leaky effect", () => {
		const code = [
			"useEffect(() => {",
			"  window.addEventListener('resize', onResize);",
			"}, []);",
		].join("\n");
		expect(checkMissingEffectCleanup(code, "/app/src/hook.ts")).toEqual([]);
	});

	it("returns [] for a .js (non-jsx) extension even with a leaky effect", () => {
		const code = [
			"useEffect(() => {",
			"  setInterval(tick, 1000);",
			"}, []);",
		].join("\n");
		expect(checkMissingEffectCleanup(code, "/app/src/hook.js")).toEqual([]);
	});

	it("returns [] when there are no useEffect calls at all", () => {
		const code = [
			"function Widget() {",
			"  window.addEventListener('resize', onResize);",
			"  return <div />;",
			"}",
		].join("\n");
		expect(checkMissingEffectCleanup(code, TSX)).toEqual([]);
	});

	it("returns [] for empty content", () => {
		expect(checkMissingEffectCleanup("", TSX)).toEqual([]);
	});
});

describe("checkMissingEffectCleanup — positive cases (.tsx, leak flagged)", () => {
	it("flags addEventListener with no cleanup return", () => {
		const code = [
			"function Widget() {",
			"  useEffect(() => {",
			"    window.addEventListener('resize', onResize);",
			"  }, []);",
			"  return <div />;",
			"}",
		].join("\n");
		const out = checkMissingEffectCleanup(code, TSX);
		expect(out).toHaveLength(1);
		// The match is reported at the useEffect start line (1-based). The
		// `useEffect(` is on source line 2.
		expect(nonNull(out[0]).line).toBe(2);
		expect(nonNull(out[0]).text).toContain("potential memory leak");
		expect(nonNull(out[0]).text).toContain("useEffect");
	});

	// test-contract: invariant — the cleanup decision is per STATEMENT, not per line: a one-line effect whose return is bare or a value keyword still leaks, while `{ …; return cleanup; }` on one line does not (review 2026-09-30, round 10)
	it("flags one-line effects whose return is bare or `null`, not one that returns a cleanup", () => {
		const code = [
			"function Widget() {",
			"  useEffect(() => { const timer = window.setInterval(refresh, 5000); return; }, []);",
			"  useEffect(() => { window.addEventListener('resize', onResize); return null; }, []);",
			"  useEffect(() => { const cleanup = store.subscribe(listener); return cleanup; }, []);",
			"  return <div />;",
			"}",
		].join("\n");
		expect(checkMissingEffectCleanup(code, TSX).map((match) => match.line)).toEqual([2, 3]);
	});

	it("flags setInterval with no cleanup return", () => {
		const code = [
			"useEffect(() => {",
			"  setInterval(() => tick(), 1000);",
			"}, []);",
		].join("\n");
		const out = checkMissingEffectCleanup(code, TSX);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(1);
	});

	it("flags setTimeout with no cleanup return", () => {
		const code = ["useEffect(() => {", "  setTimeout(fire, 100);", "}, []);"].join("\n");
		const out = checkMissingEffectCleanup(code, TSX);
		expect(out).toHaveLength(1);
	});

	it("flags subscribe(...) with no cleanup return", () => {
		const code = [
			"useEffect(() => {",
			"  store.subscribe(onChange);",
			"}, []);",
		].join("\n");
		const out = checkMissingEffectCleanup(code, TSX);
		expect(out).toHaveLength(1);
	});

	it("flags .on(...) event-emitter style with no cleanup return", () => {
		const code = [
			"useEffect(() => {",
			"  emitter.on('data', handler);",
			"}, []);",
		].join("\n");
		const out = checkMissingEffectCleanup(code, TSX);
		expect(out).toHaveLength(1);
	});

	it("fires on .jsx files too (the other allowed extension)", () => {
		const code = [
			"useEffect(() => {",
			"  window.addEventListener('scroll', onScroll);",
			"}, []);",
		].join("\n");
		const out = checkMissingEffectCleanup(code, JSX);
		expect(out).toHaveLength(1);
	});

	it("truncates the reported source line to 100 chars", () => {
		const longTail = "x".repeat(200);
		const code = [
			`  useEffect(() => { /* ${longTail} */`,
			"    window.addEventListener('resize', onResize);",
			"  }, []);",
		].join("\n");
		const out = checkMissingEffectCleanup(code, TSX);
		expect(out).toHaveLength(1);
		// text = "[...leak] " + trimmed-line-sliced-to-100. The trimmed source
		// line is far longer than 100 chars, so the sliced segment is exactly
		// 100 chars.
		const prefix = "[useEffect with subscription but no cleanup — potential memory leak] ";
		const slice = nonNull(out[0]).text.slice(prefix.length);
		expect(slice).toHaveLength(100);
	});
});

describe("checkMissingEffectCleanup — distinguishing cleanup from component returns", () => {
	it("does NOT fire when a `return () => {...}` cleanup is present", () => {
		const code = [
			"useEffect(() => {",
			"  window.addEventListener('resize', onResize);",
			"  return () => window.removeEventListener('resize', onResize);",
			"}, []);",
		].join("\n");
		expect(checkMissingEffectCleanup(code, TSX)).toEqual([]);
	});

	it("does NOT fire when a `return function() {...}` cleanup is present", () => {
		const code = [
			"useEffect(() => {",
			"  el.addEventListener('click', h);",
			"  return function () { el.removeEventListener('click', h); };",
			"}, []);",
		].join("\n");
		expect(checkMissingEffectCleanup(code, TSX)).toEqual([]);
	});

	it("does NOT fire when a `return cleanup;` identifier cleanup is present", () => {
		const code = [
			"useEffect(() => {",
			"  const cleanup = subscribe(onChange);",
			"  return cleanup;",
			"}, []);",
		].join("\n");
		expect(checkMissingEffectCleanup(code, TSX)).toEqual([]);
	});

	// test-contract: bug — a component's render return does not clean up a subscription created by its effect.
	it("still flags a subscription when the component later returns its render value", () => {
		const code = [
			"function Widget() {",
			"  useEffect(() => {",
			"    emitter.on('data', handler);",
			"  }, []);",
			"  return <div />;",
			"}",
		].join("\n");
		const out = checkMissingEffectCleanup(code, TSX);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(2);
	});

	it("does NOT fire when there is no subscription call (plain effect)", () => {
		const code = [
			"useEffect(() => {",
			"  setData(compute());",
			"}, [dep]);",
		].join("\n");
		expect(checkMissingEffectCleanup(code, TSX)).toEqual([]);
	});
});

describe("checkMissingEffectCleanup — multi-effect block boundaries", () => {
	it("scopes each effect to the span up to the NEXT useEffect (second has end=next-start)", () => {
		// First effect leaks (no cleanup); second effect is clean. The first
		// effect's scan must STOP at the second useEffect, so the second's
		// `return () =>` cleanup must NOT mask the first leak. Exercises the
		// `e + 1 < effectStarts.length` true branch (end = next effect start).
		const code = [
			"useEffect(() => {", // line 1 — leaks
			"  window.addEventListener('resize', a);",
			"}, []);",
			"useEffect(() => {", // line 4 — clean
			"  el.addEventListener('click', b);",
			"  return () => el.removeEventListener('click', b);",
			"}, []);",
		].join("\n");
		const out = checkMissingEffectCleanup(code, TSX);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(1);
	});

	it("flags BOTH effects when both leak (last effect uses end = lines.length)", () => {
		const code = [
			"useEffect(() => {", // line 1 — leaks
			"  window.addEventListener('resize', a);",
			"}, []);",
			"useEffect(() => {", // line 4 — also leaks (end = EOF)
			"  setInterval(tick, 1000);",
			"}, []);",
		].join("\n");
		const out = checkMissingEffectCleanup(code, TSX);
		expect(out).toHaveLength(2);
		expect(out.map((m) => m.line)).toEqual([1, 4]);
	});

	it("a clean effect followed by a leaking effect flags only the leaking one", () => {
		const code = [
			"useEffect(() => {", // line 1 — clean
			"  el.addEventListener('click', b);",
			"  return () => el.removeEventListener('click', b);",
			"}, []);",
			"useEffect(() => {", // line 5 — leaks
			"  window.addEventListener('resize', a);",
			"}, []);",
		].join("\n");
		const out = checkMissingEffectCleanup(code, TSX);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(5);
	});
});
