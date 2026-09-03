// Agent-clarity warning entries: cold-reader / agent-quality checks landed in
// the 2026-04 agent-quality rollout, plus the five comment-vs-behavior drift
// detectors (Mythos blog adaptation). Extracted from entries-warnings.ts —
// re-exported there as part of WARNING_ENTRIES.

import { detectCjsInEsm } from "../../checks/esm-cjs.js";
import { detectWriteWithoutMkdir } from "../../checks/fs-write-safety.js";
import { detectNaNCoercionGuards } from "../../checks/nan-coercion.js";
import { detectPolicyConstantDrift } from "../../checks/policy-constant-drift.js";
import { detectSnapshotHygiene } from "../../checks/snapshot-hygiene.js";
import { detectTypePredicateDrift } from "../../checks/type-predicate-drift.js";
import {
	checkBooleanTrap,
	checkBroadObjectTypes,
	checkCircularImports,
	checkCodeClones,
	checkDeadExports,
	checkDefaultExport,
	checkLifecycleCleanup,
	checkMagicLiteralInConditional,
	checkManyOptionalParams,
	checkPositionalOptionalBoolean,
	checkSameTypedPrimitiveParams,
	checkUntestedIdempotent,
	checkUntestedInversePair,
	checkUnvalidatedJsonBoundary,
} from "../../generic-checks.js";
import type { CheckRegistration, InlineMatch } from "../types.js";
import { COMMENT_DRIFT_ENTRIES } from "./agent-clarity-comment-drift.js";
import { RUNTIME_SAFETY_ENTRIES } from "./agent-clarity-runtime-safety.js";

// Named wrappers (not inline arrows) so Check Evidence Contract resolution
// (fn.name) can attribute evidence — an inline `fn: (a, b) => ...` arrow
// resolves its name to the property key "fn", not the real detector. `cwd`
// defaults to process.cwd() for the registry but stays overridable so tests
// can pass a temp dir, per the pattern in agent-safety-advanced.coverage.
// integration.test.ts / property-testing.integration.test.ts.

/** Registry-facing wrapper: binds `circular_imports` detection to a cwd. */
export function checkCircularImportsAtCwd(
	content: string,
	filePath: string,
	cwd: string = process.cwd(),
): InlineMatch[] {
	return checkCircularImports(content, filePath, cwd);
}

/** Registry-facing wrapper: binds `dead_exports` detection to a cwd. */
export function checkDeadExportsAtCwd(
	content: string,
	filePath: string,
	cwd: string = process.cwd(),
): InlineMatch[] {
	return checkDeadExports(content, filePath, cwd);
}

/** Registry-facing wrapper: binds `untested_inverse_pair` detection to a cwd. */
export function checkUntestedInversePairAtCwd(
	content: string,
	filePath: string,
	cwd: string = process.cwd(),
): InlineMatch[] {
	return checkUntestedInversePair(content, filePath, cwd);
}

/** Registry-facing wrapper: binds `untested_idempotent` detection to a cwd. */
export function checkUntestedIdempotentAtCwd(
	content: string,
	filePath: string,
	cwd: string = process.cwd(),
): InlineMatch[] {
	return checkUntestedIdempotent(content, filePath, cwd);
}

export const AGENT_CLARITY_ENTRIES: CheckRegistration[] = [
	{
		id: "cjs_in_esm_module",
		phase: "post",
		name: "CommonJS in ES Module",
		description:
			"Detects CommonJS constructs (require(...), module.exports, __dirname, __filename) in a file that is an ES module (top-level import/export, or a .mjs/.mts extension). These globals are undefined under ESM and throw on import - a silent class that type-checks and lints clean. Skips createRequire users, the import.meta.dirname dual pattern, and @codegen-data carriers.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This file is an ES module but uses a CommonJS construct that is undefined under ESM and throws on import. Replace require(...) with an import statement, module.exports with an export, and __dirname/__filename with import.meta.dirname or import.meta.url. If you genuinely need dynamic CommonJS, use createRequire(import.meta.url).",
		fn: detectCjsInEsm,
		resultsPropName: "cjsInEsm",
		content_keywords: ["require(", "module.exports", "__dirname", "__filename"],
	},
	{
		id: "default_export",
		phase: "post",
		name: "Default Export Hygiene",
		description:
			"Flags anonymous default exports or default exports whose symbol name does not match the filename — grep-hostile for cold readers",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Prefer a named export: `export function Foo() {}` + `import { Foo } from './foo'`. If you must use a default export (framework convention), give the symbol a name that matches the filename so grep and rename tools work: `export default function Foo() {}` in foo.ts. Anonymous `export default (...) => ...` is the worst case — rename to a named function.",
		fn: checkDefaultExport,
		resultsPropName: "defaultExport",
	},
	{
		id: "code_clones",
		phase: "post",
		name: "Code Clones (DRY)",
		description:
			"Jaccard-similarity clone detector (modeled on Uncle Bob's dry4* tools) — flags functions that are >=82% token-shingle-similar to another function in the same file or a sibling file",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Two functions share near-identical bodies. Extract the shared logic into one function and have both call sites delegate to it — parameterize the part that differs. Duplicated logic drifts: a bug fixed in one copy silently survives in the other. If the similarity is incidental (the shapes coincide but the intent is genuinely distinct), leave them separate.",
		fn: checkCodeClones,
		resultsPropName: "codeClones",
	},
	{
		id: "lifecycle_cleanup",
		phase: "post",
		name: "Lifecycle Cleanup",
		description:
			"Detects classes with a lifecycle method (dispose/destroy/close/unmount/stop) that register setInterval / setTimeout / addEventListener without the paired cleanup in the lifecycle body",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Store the handle returned by setInterval/setTimeout (or the listener function you passed to addEventListener) and pair it with clearInterval/clearTimeout/removeEventListener inside the lifecycle method. Otherwise the subscription outlives the class — a memory leak plus work that keeps happening after dispose.",
		fn: checkLifecycleCleanup,
		resultsPropName: "lifecycleCleanup",
	},
	{
		id: "circular_imports",
		phase: "post",
		name: "Circular Imports",
		description:
			"Detects import cycles involving the edited file (A → B → C → A) — unclear module boundaries that can cause runtime undefined-at-import-time bugs",
		tier: 3,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Break the cycle by moving shared types/constants to a third module that both sides depend on, or by flipping one edge to a type-only import (if it's only used in type positions). Cycles cause hard-to-debug `undefined` values at runtime because ES modules initialize one side before the other completes.",
		fn: checkCircularImportsAtCwd,
		resultsPropName: "circularImports",
	},
	{
		id: "dead_exports",
		phase: "post",
		name: "Dead Exports",
		description:
			"Detects named exports that no other file in the project imports — inflates the apparent public surface for cold readers",
		tier: 3,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Either remove the unused export (so the public surface reflects what's actually consumed) or leave a comment explaining that it's deliberately part of the public API for external consumers. Cold readers — including agents — waste time trying to understand handles that nothing actually uses.",
		fn: checkDeadExportsAtCwd,
		resultsPropName: "deadExports",
	},
	{
		id: "untested_inverse_pair",
		phase: "post",
		name: "Untested Inverse Pair",
		description:
			"Detects exported inverse pairs (encode/decode, serialize/deserialize, to<X>/from<X>) with no round-trip property test referencing both halves across the project's test files",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Add a round-trip property test asserting the inverse law -- e.g. with fast-check: `fc.assert(fc.property(fc.string(), (x) => expect(decode(encode(x))).toBe(x)))`. The round trip is the cheapest high-mutation-kill test for an encode/decode-style pair; its absence means the pair is unverified against malformed or edge-case inputs.",
		fn: checkUntestedInversePairAtCwd,
		resultsPropName: "untestedInversePair",
	},
	{
		id: "untested_idempotent",
		phase: "post",
		name: "Untested Idempotent",
		description:
			"Detects exported idempotent-shaped functions (normalize/sanitize/dedupe) with no property test asserting the f(f(x)) === f(x) law",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Add a property test asserting idempotence with fast-check: `fc.assert(fc.property(fc.string(), (x) => expect(f(f(x))).toEqual(f(x))))`. A normalizer/sanitizer must be safe to apply twice; the property catches the case where a second pass changes the output.",
		fn: checkUntestedIdempotentAtCwd,
		resultsPropName: "untestedIdempotent",
	},
	{
		id: "unvalidated_json_boundary",
		phase: "post",
		name: "Unvalidated JSON Boundary",
		description:
			"Detects `JSON.parse(...)` / `await <x>.json()` results that reach property access without passing through a schema parser (zod, valibot, ajv, yup, io-ts, arktype)",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Pipe the parsed value through a schema parser before using it: `const parsed = MySchema.parse(JSON.parse(raw));`. This gives you both a runtime validation error on malformed input AND a typed value downstream — cold readers see `parsed.field` and know the shape is guaranteed, not just a hope.",
		fn: checkUnvalidatedJsonBoundary,
		resultsPropName: "unvalidatedJsonBoundary",
	},
	{
		id: "magic_literal_in_conditional",
		phase: "post",
		name: "Magic Literal in Conditional",
		description:
			"Detects if/switch branches that compare against a bare numeric or string literal instead of a named constant — cold readers can't tell what the branch means",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Extract the literal into a named constant or enum so the conditional reads as intent. `if (status === ORDER_FULFILLED)` tells a cold reader what branch they're in; `if (status === 2)` forces them to grep for where 2 is defined.",
		fn: checkMagicLiteralInConditional,
		resultsPropName: "magicLiteralInConditional",
	},
	{
		id: "nan_coercion_guard",
		phase: "post",
		name: "NaN Coercion Guard",
		description:
			"Detects Date.parse / Number / parseInt / parseFloat results used in a relational comparison (<, >, <=, >=) without a Number.isFinite / Number.isNaN / isNaN guard — NaN makes the comparison silently false, falling through to a permissive/default branch (fail-open).",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A coercion (Date.parse/Number/parseInt/parseFloat) can return NaN on malformed input, and `NaN <= x` / `NaN >= x` is always false — so the guarded branch is silently skipped (e.g. an expired record treated as live forever). Guard the value before the comparison: `if (!Number.isFinite(n)) return ...;` then compare, or inline `Number.isFinite(parsed) && parsed <= limit`. Equality (=== / !==) is fine; only relational operators fail-open on NaN.",
		fn: detectNaNCoercionGuards,
		resultsPropName: "nanCoercionGuard",
		content_keywords: ["Date.parse", "Number(", "parseInt", "parseFloat"],
	},
	{
		id: "write_without_mkdir",
		phase: "post",
		name: "Write Without mkdir",
		description:
			"Detects writeFileSync / appendFileSync / writeFile / createWriteStream calls on a nested path (join(...) with ≥2 args, or a string literal containing a slash) with no prior mkdirSync(..., { recursive: true }) / mkdir(..., { recursive: true }) / existsSync guard in the same function scope — throws ENOENT when the parent directory is absent.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Writing to a nested path throws ENOENT when the parent directory doesn't exist yet. Create the directory first: `mkdirSync(dirname(target), { recursive: true });` (or the async `await mkdir(...)`) before the write, or guard with `existsSync(dir)`. The recursive flag makes the call a no-op when the directory already exists.",
		fn: detectWriteWithoutMkdir,
		resultsPropName: "writeWithoutMkdir",
		content_keywords: ["writeFileSync", "appendFileSync", "writeFile", "createWriteStream"],
	},
	{
		id: "duplicated_policy_constant",
		phase: "post",
		name: "Duplicated Policy Constant",
		description:
			"Detects a file that declares a named policy constant (DEFAULT_* / MAX_* / MIN_* / *_CAP / *_THRESHOLD / *_LIMIT) and then also hard-codes the same bare numeric literal on another line instead of referencing the constant — the literal silently diverges when the constant is later changed.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A bare literal repeats the value of a named policy constant defined in the same file. Reference the constant (e.g. `MAX_RETRIES` instead of the bare `7`) so the two can't drift — when the cap changes, every use updates with it. Trivial numbers (0, 1, 2, 100, 1000, …) are already excluded, so a flagged literal is a genuine policy value.",
		fn: detectPolicyConstantDrift,
		resultsPropName: "duplicatedPolicyConstant",
	},
	{
		id: "type_predicate_drift",
		phase: "post",
		name: "Type Predicate Drift",
		description:
			"Detects a hand-rolled `value is T` type predicate that checks some of T's required properties but silently ignores others — a `v is T` annotation is an unchecked assertion, so the compiler never notices the gap and a field added to T stays unvalidated forever",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A `v is T` return type is an assertion the compiler never verifies against the body, so the listed required fields of T go unchecked at runtime. Replace the predicate with a parser that returns a CONSTRUCTED object: `function parseT(v: unknown): T | null { … return { a, b, c }; }`. The object literal IS checked against T, so adding a required field fails to compile here instead of silently under-validating at the boundary.",
		fn: detectTypePredicateDrift,
		resultsPropName: "typePredicateDrift",
	},
	{
		id: "snapshot_hygiene",
		phase: "post",
		name: "Snapshot Hygiene",
		description:
			"Detects a write whose target path is a snapshot-review artifact that must never be committed — jest/vitest `*.snap.new` or cargo-insta `*.pending-snap` (including under __snapshots__/ and snapshots/). Committing one is the snapshot analog of leaving an `.only`/`.skip` behind: the runner ignores it at test time, so the assertion looks satisfied but isn't.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This is a snapshot-review artifact (`*.snap.new` / `*.pending-snap`), not an accepted snapshot. Runners write it on a mismatch and IGNORE it at test time, so committing it neither fixes the test nor lands a real snapshot. Regenerate the accepted snapshot through the runner instead: `vitest -u` (or `jest -u`) for `.snap.new`, `cargo insta accept` for `.pending-snap`.",
		fn: detectSnapshotHygiene,
		resultsPropName: "snapshotHygiene",
		content_keywords: [],
	},
	...RUNTIME_SAFETY_ENTRIES,
	{
		id: "boolean_trap",
		phase: "post",
		name: "Boolean Trap",
		description:
			"Detects function calls with 2+ boolean literal arguments — the reader can't tell what each bool means without jumping to the definition",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Replace positional booleans with an options object so the intent is visible at the call site: `createUser('alice', { admin: true, verified: false })` instead of `createUser('alice', true, false)`. Alternatively, use an enum when the booleans represent a discrete mode.",
		fn: checkBooleanTrap,
		resultsPropName: "booleanTrap",
	},
	{
		id: "positional_optional_boolean",
		phase: "post",
		name: "Positional Optional Boolean",
		description:
			"Signature-side twin of boolean_trap — detects function declarations with a positional optional boolean parameter (`flag?: boolean`, `flag: boolean = false`, or `flag = false`). Every call site of such a function is unreadable: `setUser(\"alice\", true)` gives a cold reader no clue what `true` means.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Move the boolean into an options object so the intent is visible at every call site: `function setUser(name: string, opts: { force?: boolean } = {})` and `setUser('alice', { force: true })`. If the boolean represents a discrete mode (e.g. read/write), promote it to a string-literal union or enum. A single positional optional boolean is the cause of the boolean-trap class — defining it that way pre-commits every caller to the unreadable shape.",
		fn: checkPositionalOptionalBoolean,
		resultsPropName: "positionalOptionalBoolean",
	},
	{
		id: "many_optional_params",
		phase: "post",
		name: "Many Optional Params",
		description:
			"Detects function signatures with 3+ optional parameters (`?:` TS markers or `=` defaults combined). Each optional doubles the call-shape surface — 3 optionals = 8 untested call shapes, and a default change becomes a silent semantic API break.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Replace the optional positional params with a single options-object parameter so the call shapes collapse into one and defaults are visible at the schema level: `function build(name: string, opts: { cache?: boolean; retries?: number; timeout?: number } = {})`. Cold readers see every knob in one place, and adding a new option doesn't reorder or expand the signature.",
		fn: checkManyOptionalParams,
		resultsPropName: "manyOptionalParams",
	},
	{
		id: "same_typed_primitive_params",
		phase: "post",
		name: "Same-Typed Primitive Params",
		description:
			"Detects exported / public-method signatures with two consecutive primitive parameters of the same surface type (string, number, boolean) — callers can swap them without a type error, so the ordering risk is structural, not a typo",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Two adjacent parameters of the same primitive type are orderable by mistake — `transfer(fromId: string, toId: string, amount: number)` compiles cleanly when called as `transfer(toId, fromId, amount)`. Make the illegal state unrepresentable: branded types (`type UserId = string & { __brand: 'UserId' }`, `type AccountId = string & { __brand: 'AccountId' }`) keep the runtime cost zero while the compiler now rejects the swapped call. Alternatively, take a single struct parameter and destructure by name: `transfer({ fromId, toId, amount }: { fromId: string; toId: string; amount: number })` — call sites become self-documenting and order-independent.",
		fn: checkSameTypedPrimitiveParams,
		resultsPropName: "sameTypedPrimitiveParams",
	},
	{
		id: "broad_object_types",
		phase: "pre_warn",
		name: "Broad Object Types",
		description:
			"Detects Record<K, any>, index signatures to any, and bare Function/object type annotations that hide shape information",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This type hides the shape of the value. Replace `Record<K, any>` / `{ [k: string]: any }` with a specific interface or typed map (e.g., `Record<UserId, UserProfile>`). Replace bare `Function` with a specific signature (`(x: number) => string`). Replace bare `object` with the actual object shape. Cold readers can't know what's expected otherwise.",
		fn: checkBroadObjectTypes,
		resultsPropName: "broadObjectTypes",
	},
	...COMMENT_DRIFT_ENTRIES,
];
