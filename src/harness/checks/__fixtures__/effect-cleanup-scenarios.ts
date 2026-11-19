import { afterAll, beforeAll, expect } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { __setPackageRootForTesting } from "../shared.js";
import { bindEffectCleanupCases, type EffectCleanupCases, type EffectCleanupCheck } from "./effect-cleanup-registration.js";

// A .tsx component path that is NOT a test file and NOT under the pinned
// package root — so neither the strict-test nor the harness-internal exemption
// fires.
const TSX = "/app/src/components/Widget.tsx";
const JSX = "/app/src/components/Widget.jsx";

const earlyReturnCases: EffectCleanupCases = {
	"returns [] for a test file (.test.tsx) regardless of content": (checkMissingEffectCleanup) => {
		const code = [
			"useEffect(() => {",
			"  window.addEventListener('resize', onResize);",
			"}, []);",
		].join("\n");
		// `.test.tsx` matches the strict-test filename regex → isTestFile true.
		expect(checkMissingEffectCleanup(code, "/app/src/Widget.test.tsx")).toEqual([]);
	},

	"returns [] for a path inside a __tests__/ directory": (checkMissingEffectCleanup) => {
		const code = [
			"useEffect(() => {",
			"  el.addEventListener('click', h);",
			"}, []);",
		].join("\n");
		expect(checkMissingEffectCleanup(code, "/app/__tests__/Widget.tsx")).toEqual([]);
	},

	"returns [] for a non-tsx/jsx extension (.ts) even with a leaky effect": (checkMissingEffectCleanup) => {
		const code = [
			"useEffect(() => {",
			"  window.addEventListener('resize', onResize);",
			"}, []);",
		].join("\n");
		expect(checkMissingEffectCleanup(code, "/app/src/hook.ts")).toEqual([]);
	},

	"returns [] for a .js (non-jsx) extension even with a leaky effect": (checkMissingEffectCleanup) => {
		const code = [
			"useEffect(() => {",
			"  setInterval(tick, 1000);",
			"}, []);",
		].join("\n");
		expect(checkMissingEffectCleanup(code, "/app/src/hook.js")).toEqual([]);
	},

	"returns [] when there are no useEffect calls at all": (checkMissingEffectCleanup) => {
		const code = [
			"function Widget() {",
			"  window.addEventListener('resize', onResize);",
			"  return <div />;",
			"}",
		].join("\n");
		expect(checkMissingEffectCleanup(code, TSX)).toEqual([]);
	},

	"returns [] for empty content": (checkMissingEffectCleanup) => {
		expect(checkMissingEffectCleanup("", TSX)).toEqual([]);
	},
};

const leakingEffectCases: EffectCleanupCases = {
	"flags addEventListener with no cleanup return": (checkMissingEffectCleanup) => {
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
	},

	// test-contract: invariant — the cleanup decision is per STATEMENT, not per line: a one-line effect whose return is bare or a value keyword still leaks, while `{ …; return cleanup; }` on one line does not (review 2026-09-30, round 10)
	"flags one-line effects whose return is bare or `null`, not one that returns a cleanup": (checkMissingEffectCleanup) => {
		const code = [
			"function Widget() {",
			"  useEffect(() => { const timer = window.setInterval(refresh, 5000); return; }, []);",
			"  useEffect(() => { window.addEventListener('resize', onResize); return null; }, []);",
			"  useEffect(() => { const cleanup = store.subscribe(listener); return cleanup; }, []);",
			"  return <div />;",
			"}",
		].join("\n");
		expect(checkMissingEffectCleanup(code, TSX).map((match) => match.line)).toEqual([2, 3]);
	},

	"flags setInterval with no cleanup return": (checkMissingEffectCleanup) => {
		const code = [
			"useEffect(() => {",
			"  setInterval(() => tick(), 1000);",
			"}, []);",
		].join("\n");
		const out = checkMissingEffectCleanup(code, TSX);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(1);
	},

	"flags setTimeout with no cleanup return": (checkMissingEffectCleanup) => {
		const code = ["useEffect(() => {", "  setTimeout(fire, 100);", "}, []);"].join("\n");
		const out = checkMissingEffectCleanup(code, TSX);
		expect(out).toHaveLength(1);
	},

	"flags subscribe(...) with no cleanup return": (checkMissingEffectCleanup) => {
		const code = [
			"useEffect(() => {",
			"  store.subscribe(onChange);",
			"}, []);",
		].join("\n");
		const out = checkMissingEffectCleanup(code, TSX);
		expect(out).toHaveLength(1);
	},

	"flags .on(...) event-emitter style with no cleanup return": (checkMissingEffectCleanup) => {
		const code = [
			"useEffect(() => {",
			"  emitter.on('data', handler);",
			"}, []);",
		].join("\n");
		const out = checkMissingEffectCleanup(code, TSX);
		expect(out).toHaveLength(1);
	},

	"fires on .jsx files too (the other allowed extension)": (checkMissingEffectCleanup) => {
		const code = [
			"useEffect(() => {",
			"  window.addEventListener('scroll', onScroll);",
			"}, []);",
		].join("\n");
		const out = checkMissingEffectCleanup(code, JSX);
		expect(out).toHaveLength(1);
	},

	"truncates the reported source line to 100 chars": (checkMissingEffectCleanup) => {
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
	},
};

const cleanupReturnCases: EffectCleanupCases = {
	"does NOT fire when a `return () => {...}` cleanup is present": (checkMissingEffectCleanup) => {
		const code = [
			"useEffect(() => {",
			"  window.addEventListener('resize', onResize);",
			"  return () => window.removeEventListener('resize', onResize);",
			"}, []);",
		].join("\n");
		expect(checkMissingEffectCleanup(code, TSX)).toEqual([]);
	},

	"does NOT fire when a `return function() {...}` cleanup is present": (checkMissingEffectCleanup) => {
		const code = [
			"useEffect(() => {",
			"  el.addEventListener('click', h);",
			"  return function () { el.removeEventListener('click', h); };",
			"}, []);",
		].join("\n");
		expect(checkMissingEffectCleanup(code, TSX)).toEqual([]);
	},

	"does NOT fire when a `return cleanup;` identifier cleanup is present": (checkMissingEffectCleanup) => {
		const code = [
			"useEffect(() => {",
			"  const cleanup = subscribe(onChange);",
			"  return cleanup;",
			"}, []);",
		].join("\n");
		expect(checkMissingEffectCleanup(code, TSX)).toEqual([]);
	},

	// test-contract: bug — a component's render return does not clean up a subscription created by its effect.
	"still flags a subscription when the component later returns its render value": (checkMissingEffectCleanup) => {
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
	},

	"does NOT fire when there is no subscription call (plain effect)": (checkMissingEffectCleanup) => {
		const code = [
			"useEffect(() => {",
			"  setData(compute());",
			"}, [dep]);",
		].join("\n");
		expect(checkMissingEffectCleanup(code, TSX)).toEqual([]);
	},
};

const effectBoundaryCases: EffectCleanupCases = {
	"scopes each effect to the span up to the NEXT useEffect (second has end=next-start)": (checkMissingEffectCleanup) => {
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
	},

	"flags BOTH effects when both leak (last effect uses end = lines.length)": (checkMissingEffectCleanup) => {
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
	},

	"a clean effect followed by a leaking effect flags only the leaking one": (checkMissingEffectCleanup) => {
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
	},
};

export function effectCleanupScenarios(check: EffectCleanupCheck) {
	beforeAll(() => {
		__setPackageRootForTesting("/nonexistent-pkg-root");
	});
	afterAll(() => {
		__setPackageRootForTesting(undefined);
	});
	return {
		"checkMissingEffectCleanup — early-return gates": bindEffectCleanupCases(earlyReturnCases, check),
		"checkMissingEffectCleanup — positive cases (.tsx, leak flagged)": bindEffectCleanupCases(leakingEffectCases, check),
		"checkMissingEffectCleanup — distinguishing cleanup from component returns": bindEffectCleanupCases(cleanupReturnCases, check),
		"checkMissingEffectCleanup — multi-effect block boundaries": bindEffectCleanupCases(effectBoundaryCases, check),
	};
}
