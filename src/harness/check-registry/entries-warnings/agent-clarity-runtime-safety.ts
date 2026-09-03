// Runtime-safety warning entries: the memory-safety / lifetime / boundary
// detector cluster adapted from the Firefox security-bug corpus (iterator
// invalidation, fresh-identity key lookups, switch exhaustiveness, TOCTOU
// across await, cleanup re-entry and early-exit leaks, unvalidated boundary
// copies, tainted privileged sinks, unchecked index bounds). Extracted from
// agent-clarity.ts — spread back into AGENT_CLARITY_ENTRIES there.

import {
	checkAwaitStateToctou,
	checkBoundaryCopyNoRevalidation,
	checkCleanupReentrancy,
	checkCleanupSkippedOnEarlyExit,
	checkDiscriminatedUnionExhaustiveness,
	checkFreshCollectionKeyLookup,
	checkIndexBoundsUnchecked,
	checkIteratorInvalidation,
	checkTaintedToPrivilegedSink,
} from "../../generic-checks.js";
import type { CheckRegistration } from "../types.js";

export const RUNTIME_SAFETY_ENTRIES: CheckRegistration[] = [
	{
		id: "iterator_invalidation",
		phase: "post",
		name: "Iterator Invalidation",
		description:
			"Detects mutating an array, Map, or Set inside iteration over the same collection (push/splice/delete/clear/set/add inside for-of, for-in, forEach, or other iteration callbacks)",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Mutating the same collection you're iterating leads to skipped elements, double-visits, or in C++ analogs (Firefox bug 2025977) freed-backing-store UAFs. Either snapshot first (`for (const x of [...items]) { items.delete(x); }`), build a deletion list and apply it after the loop, or switch to a primitive that documents safe-during-iteration semantics (e.g. `filter` returning a new array).",
		fn: checkIteratorInvalidation,
		resultsPropName: "iteratorInvalidation",
	},
	{
		id: "fresh_collection_key_lookup",
		phase: "post",
		name: "Fresh Collection Key Lookup",
		description:
			"Detects Map/Set .set/.get/.has/.add called with a fresh-identity value (NaN, empty/spread object literal, fresh Symbol, fresh `new` instance) — the lookup is a guaranteed miss because identity differs from any previously inserted key",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"`new Map().set({}, 1).get({})` returns `undefined` — the two `{}` literals have different identities. Use a stable key: a primitive (string/number, with NaN explicitly excluded), a value held in a variable across the set/get pair, or a WeakMap keyed on the stable object reference itself.",
		fn: checkFreshCollectionKeyLookup,
		resultsPropName: "freshCollectionKeyLookup",
	},
	{
		id: "discriminated_union_exhaustiveness",
		phase: "post",
		name: "Discriminated Union Exhaustiveness",
		description:
			"Detects TypeScript switch statements on literal-union or discriminated-union types where exhaustiveness is not asserted in the default branch — adding a new union member silently falls through the default with no compile-time error",
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Either cover every case explicitly OR add an exhaustiveness assertion in the default branch. Three idioms work: (a) `default: { const _exhaustive: never = value; throw new Error('unreachable: ' + _exhaustive); }` — TS will refuse to compile when a new union member is added without a matching case; (b) `default: assertNever(value);` using a helper `function assertNever(x: never): never { throw new Error('unreachable: ' + x); }`; (c) `default: throw new UnreachableError(...);` paired with the assertion form. A bare `default: break;` or `default: return -1;` provides no compile-time safety against the next union member you forget to handle.",
		fn: checkDiscriminatedUnionExhaustiveness,
		resultsPropName: "discriminatedUnionExhaustiveness",
		content_keywords: ["switch"],
	},
	{
		id: "await_state_toctou",
		phase: "post",
		name: "Await State TOCTOU",
		description:
			"Detects `if (X.Y) { ... await ...; X.Y.method() }` shapes where the same dotted field is checked before an await and used after, with no re-check between. State may have changed during the await — use the value through the original reference at risk.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"After the await, re-verify the field exists before using it: `if (state.entry) { await sync(); if (state.entry) state.entry.touch(); }`. Or hoist the value to a local before the await: `const entry = state.entry; if (entry) { await sync(); entry.touch(); }` — the local survives the await regardless of whether `state.entry` was reassigned. Firefox bugs 2021894/2022733 were the C++ analog: IPC race over async boundaries.",
		fn: checkAwaitStateToctou,
		resultsPropName: "awaitStateToctou",
	},
	{
		id: "cleanup_reentrancy",
		phase: "post",
		name: "Cleanup Reentrancy",
		description:
			"Detects dispose/destroy/close/teardown methods that recurse into themselves, or useEffect cleanups that mutate React state — re-entry during teardown can fire another lifecycle event on a partially-destroyed instance",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"For class cleanup: guard recursion with a destroyed-flag (`if (this.destroyed) return; this.destroyed = true; ...`) or restructure so the cleanup is idempotent and only owns its own resources, not delegated re-cleanup. For useEffect: cleanups should release resources, not mutate state — calling setState in a cleanup triggers a render after teardown. Firefox bugs 2024653/2027298 were the C++ analog: UAF via re-entry during actor teardown.",
		fn: checkCleanupReentrancy,
		resultsPropName: "cleanupReentrancy",
	},
	{
		id: "boundary_copy_no_revalidation",
		phase: "post",
		name: "Boundary Copy No Revalidation",
		description:
			"Detects Object.assign / spread copy of external input (req.body|query|params, process.argv|env, JSON.parse output) into a typed slot without passing through a recognized validator first",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Validate before copying: `Object.assign(slot, Schema.parse(req.body))` or `const validated = Schema.parse(req.body); slot = { ...slot, ...validated };`. Without it, the typed slot now holds whatever shape the external input had — TypeScript types lie, runtime shape doesn't match the declared interface, and downstream code crashes on the unexpected shape. Firefox bug 2029813 was the C++ analog: RLBox copy verification gap.",
		fn: checkBoundaryCopyNoRevalidation,
		resultsPropName: "boundaryCopyNoRevalidation",
	},
	{
		id: "tainted_to_privileged_sink",
		phase: "post",
		name: "Tainted to Privileged Sink",
		description:
			"Detects external-input values (req.body|query|params, process.argv|env) reaching a privileged sink (eval, new Function, vm.run*, child_process.exec*, fs.write*) without passing through a recognized validator (zod/.parse, .safeParse, .validate, typeof, instanceof, Array.isArray, allow-list .has)",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Validate the value before it reaches the sink. Preferred: schema-parse it (`const cmd = CmdSchema.parse(req.body.cmd)`). Acceptable: typeof + allow-list (`if (typeof cmd !== 'string' || !ALLOW.has(cmd)) return`). Avoid passing un-narrowed external input to eval / new Function / child_process.exec / vm.run / fs.write — Firefox bug 2023817 was the C++ analog: the parent process trusted sandbox-supplied input that hadn't been re-validated at the trust boundary.",
		fn: checkTaintedToPrivilegedSink,
		resultsPropName: "taintedToPrivilegedSink",
	},
	{
		id: "cleanup_skipped_on_early_exit",
		phase: "post",
		name: "Cleanup Skipped on Early Exit",
		description:
			"Detects setInterval/setTimeout/subscribe/addEventListener acquisitions where a throw or return reaches before the matching release, with no try/finally wrap — the resource leaks on the early-exit path",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Wrap the acquisition + body in `try { ... } finally { <cleanup> }` so the cleanup runs on every exit path including thrown exceptions and early returns. Without it, the throw skips the cleanup, leaking the timer/listener/subscription. Firefox bug 2024653/2027298 — same shape, different language: the `try { ... } finally { ctrl.abort(); ws.close(); }` pattern is the JS-side fix.",
		fn: checkCleanupSkippedOnEarlyExit,
		resultsPropName: "cleanupSkippedOnEarlyExit",
	},
	{
		id: "index_bounds_unchecked",
		phase: "post",
		name: "Index Bounds Unchecked",
		description:
			"Detects external-input numeric values (Number/parseInt/parseFloat applied to req.body|query|params or process.argv|env) reaching an array subscript without a Number.isFinite or length-bound guard between parse and use",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Validate the parsed number before indexing: `if (!Number.isFinite(n) || n < 0 || n >= rows.length) return null; return rows[n];`. Without the guard, NaN/Infinity, negatives, or values past the end give `undefined` (or worse: silently match string-keyed properties). Firefox bug 2026305 was a 16-bit field overflow in this shape — same logic, different language.",
		fn: checkIndexBoundsUnchecked,
		resultsPropName: "indexBoundsUnchecked",
	},
];
