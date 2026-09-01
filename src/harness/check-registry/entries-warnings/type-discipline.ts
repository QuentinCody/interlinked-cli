// Type-discipline wave (2026-08-14): two detectors ported from
// dmmulroy/anti-slop (MIT), detection algorithm only — see
// docs/external-pulse/anti-slop.md. Both are new, post-phase, advisory
// (DEFAULT_ADVISORY_SKIPS) pending dogfood FP calibration. Two source
// files (per-file line cap): type-discipline.ts +
// type-discipline-unknown-alias.ts.

import { checkDeadTypeExports } from "../../checks/dead-exports-inline.js";
import { detectConditionalEmptyObjectSpread } from "../../checks/type-discipline.js";
import { detectUnknownTypeAlias } from "../../checks/type-discipline-unknown-alias.js";
import { checkDuplicateTypeDeclaration } from "../../checks/type-redundancy.js";
import { detectTagReflectionTypeCheck } from "../../checks/tag-reflection.js";
import type { CheckRegistration, InlineMatch } from "../types.js";

// Named wrappers (not inline arrows) so Check Evidence Contract resolution
// (fn.name) attributes evidence to the real detector; cwd stays overridable
// for tests (same pattern as agent-clarity.ts).

/** Registry-facing wrapper: binds `dead_type_exports` detection to a cwd. */
export function checkDeadTypeExportsAtCwd(
	content: string,
	filePath: string,
	cwd: string = process.cwd(),
): InlineMatch[] {
	return checkDeadTypeExports(content, filePath, cwd);
}

/** Registry-facing wrapper: binds `duplicate_type_declaration` to a cwd. */
export function checkDuplicateTypeDeclarationAtCwd(
	content: string,
	filePath: string,
	cwd: string = process.cwd(),
): InlineMatch[] {
	return checkDuplicateTypeDeclaration(content, filePath, cwd);
}

export const TYPE_DISCIPLINE_ENTRIES: CheckRegistration[] = [
	{
		id: "dead_type_exports",
		phase: "post",
		name: "Dead Type Exports",
		description:
			"Detects exported interfaces/type aliases no other file imports (type-aware consumption: `import type`, inline `{ type X }` specifiers, dynamic imports, re-export barrels). Types are erased at compile time, so the finding is pure reading overhead once nothing consumes it — from the 2026-09-01 dead-code campaign (694 on this tree at introduction).",
		tier: 3,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"If the type is still used inside its own file, remove the `export` keyword — behavior-neutral, and `noUnusedLocals` then watches it (the measured majority remedy: 582/585). If nothing references it at all, delete the declaration. Keep it only for a documented external consumer — add a 'public API' comment above it.",
		fn: checkDeadTypeExportsAtCwd,
		resultsPropName: "deadTypeExports",
		content_keywords: ["export interface ", "export type "],
	},
	{
		id: "duplicate_type_declaration",
		phase: "post",
		name: "Duplicate Type Declaration",
		description:
			"Detects an exported interface/type alias whose NAME another module also declares (34 homonym names measured on this tree at introduction). Identical bodies drift apart silently — the type-level twin of code_clones; divergent bodies misroute auto-imports to the wrong shape.",
		tier: 3,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"For an IDENTICAL body: keep one declaration and re-export it (`export type { X } from './canonical.js'`). For a DIFFERENT body: rename one side so the name maps to exactly one shape repo-wide.",
		fn: checkDuplicateTypeDeclarationAtCwd,
		resultsPropName: "duplicateTypeDeclaration",
		content_keywords: ["export interface ", "export type "],
	},
	{
		id: "conditional_empty_object_spread",
		phase: "post",
		name: "Conditional Empty-Object Spread",
		description:
			"Detects an object-literal spread whose argument is a ternary with an empty object `{}` on one branch — `{ ...(cond ? {} : { field: v }) }` — used to conditionally omit a field. Exempts the idiomatic guarded-passthrough shape `<guard> ? { key: expr } : {}` (bare truthy, `!== undefined`, `typeof`, `.length`/`.size`) whose property value textually matches the guard — tightened from 241 to 32 corpus fires on this repo. Ported from anti-slop's no-conditional-empty-object-spread.ts (report-only; the upstream autofix is not ported).",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A ternary spread that conditionally includes/omits a field is fragile to read. Prefer a direct conditional property (build the value in a named intermediate) or two separate statements instead of spreading `{}` vs. a populated object.",
		fn: detectConditionalEmptyObjectSpread,
		resultsPropName: "conditionalEmptyObjectSpread",
		content_keywords: ["..."],
	},
	{
		id: "unknown_type_alias",
		phase: "post",
		name: "Unknown Type Alias",
		description:
			"Detects a named type alias whose resolved type (chased through same-file, non-generic alias references) is exactly `unknown` — e.g. `type Foo = unknown;`. Invisible to the existing type-density ratchet, which only matches a literal `: unknown` annotation, not a bare alias declaration. Ported from anti-slop's no-unknown-type-aliases.ts.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This alias only renames TypeScript's `unknown` top type. Keep `unknown` explicit at the boundary that actually needs it (an allowed `cause` field, a JSON.parse result awaiting a schema parser) or replace the alias with the real parsed type once it's known.",
		fn: detectUnknownTypeAlias,
		resultsPropName: "unknownTypeAlias",
		content_keywords: ["unknown"],
	},
	{
		id: "tag_reflection_type_check",
		phase: "post",
		name: "Tag-Reflection Type Check",
		description:
			'Detects a tag-reflection type check for a primitive (`instanceof String/Number/Boolean` or `Object.prototype.toString.call(x) === "[object String/Number/Boolean]"`) where `typeof` already answers the question. Object.prototype.toString comparisons against non-primitive tags (Date, Array, RegExp, Map, etc.) are not flagged — typeof cannot distinguish those, so tag reflection is the correct tool there.',
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			'Prefer `typeof x === "string"` (or "number"/"boolean") over instanceof/tag-reflection checks for these three primitive types — tag reflection is spoofable via Symbol.toStringTag and does not survive a cross-realm value (an object from another iframe/vm reports its own realm\'s tag).',
		fn: detectTagReflectionTypeCheck,
		resultsPropName: "tagReflectionTypeCheck",
		content_keywords: ["instanceof", "[object "],
	},
];
