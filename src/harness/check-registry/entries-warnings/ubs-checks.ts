// UBS (Plan 04) warning entries: language-specific bug-class detectors for
// JS/TS, Python, Java, Go, and C/C++, plus the package.json-script-paths and
// tsconfig-strictness manifest checks. Several Plan 04 D.1 entries carry
// severity=error but run in the pre_warn / post phases. Extracted from
// entries-warnings.ts — re-exported there as part of WARNING_ENTRIES.

import { checkIdenticalBranches } from "../../checks/identical-branches.js";
import { checkPackageJsonScriptPaths, checkTsconfigStrictness } from "../../generic-checks.js";
import type { CheckRegistration } from "../types.js";
import { UBS_ENTRIES_EXTRA } from "./ubs-checks-extra.js";
import { UBS_ENTRIES_LANG } from "./ubs-checks-lang.js";

export const UBS_ENTRIES: CheckRegistration[] = [
	// === UBS Plan 04 — rows 27–30 (warning/post tier); language-specific
	// detectors split out to ubs-checks-lang.ts, spread back in here. ===
	...UBS_ENTRIES_LANG,
	{
		id: "package_json_script_paths",
		phase: "post",
		name: "Package JSON Script Paths",
		description:
			"Detects package.json scripts that reference files which don't exist on disk (node ./X.mjs, tsc -p X.json, --config X). Catches the universal CI failure where a manifest declares a script path the file tree doesn't have.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A package.json script references a file that doesn't exist. Either create the file at the referenced path, fix the path to point at an existing file, or remove the script if it's no longer needed. The script will fail the moment anyone runs it.",
		fn: checkPackageJsonScriptPaths,
		resultsPropName: "packageJsonScriptPaths",
	},
	{
		id: "tsconfig_strictness",
		phase: "post",
		name: "tsconfig Strictness",
		description:
			"Detects tsconfig*.json files missing high-leverage strictness flags (noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride, noImplicitReturns, noFallthroughCasesInSwitch). None of these are implied by `strict: true`; each catches a documented bug class the type system would otherwise let through.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Add the named strictness flag(s) to `compilerOptions` in your tsconfig and set them to `true`. Each finding includes the one-line rationale for the specific flag. `strict: true` does NOT cover any of the five flags this check enforces — they need to be set explicitly. If you genuinely cannot enable a flag yet, set it to `false` explicitly in the tsconfig with a comment explaining why (this check looks for absence, not the false value).",
		fn: checkTsconfigStrictness,
		resultsPropName: "tsconfigStrictness",
		// The detector itself short-circuits on basename and `compilerOptions`
		// presence; this keyword gate avoids opening the function on the
		// thousands of unrelated .json files an edit-stream can touch.
		content_keywords: ["compilerOptions", "extends"],
	},
	{
		id: "identical_conditional_branches",
		phase: "pre_warn",
		name: "Identical Conditional Branches",
		description:
			"Detects an if/else (or ternary) whose branches are identical after comment/whitespace normalization — the condition has no effect, the same value/effect is produced either way. String literals are preserved so differing literals stay distinct. Brace-delimited languages (JS/TS, Rust, Go, Java, Kotlin, Swift, Scala, C/C++/ObjC, C#, PHP, Dart). Mirrors SonarQube S3923 and Clippy `if_same_then_else`.",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Both branches of this conditional produce the same result, so the condition is dead weight. Either (a) the branches were meant to differ — fix the one that's wrong; or (b) the condition is genuinely irrelevant — delete the if/else (or ternary) and keep the single shared body. Identical branches are a SonarQube S3923 bug and a Clippy `if_same_then_else` correctness lint: almost always a copy-paste that was never finished editing.",
		fn: checkIdenticalBranches,
		resultsPropName: "identicalConditionalBranches",
		// One of `else` (block form) or `?` (ternary) must be present for either
		// shape to exist — cheap gate before the brace-scan + strip.
		content_keywords: ["else", "?"],
	},
	...UBS_ENTRIES_EXTRA,
];
