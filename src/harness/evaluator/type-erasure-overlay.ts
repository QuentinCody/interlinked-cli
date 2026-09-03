// ===========================================
// Type-Erasure Diff Overlay (PreToolUse)
// ===========================================
//
// Detects type-erasure patterns introduced by an edit: `as any`,
// `as unknown as` chains, unjustified `@ts-ignore` / `@ts-expect-error`
// directives, and bare `: any` annotations. Mirrors the count-delta
// pattern used by the existing `as_any_ratchet` post-edit warning, but
// runs at PreToolUse so the agent is blocked BEFORE the edit lands.
//
// Gated by `rules.quality_checks.strict_typing_block.enabled` — off by
// default. Hard-blocking at edit time is a one-way door for agent
// friction: ship behind the flag, watch override rate, default it on
// once stable.

import { existsSync, readFileSync } from "node:fs";
import { nonNull } from "../../lib/non-null.js";
import { stripAllLiterals } from "../strip-helpers.js";

/** A single new instance of a type-erasure pattern, keyed for diffing. */
interface TypeErasureFinding {
	line: number;
	column: number;
	ruleId: string;
	message: string;
	/** Stable key for multiset subtract: rule + trimmed original line text. */
	matchKey: string;
}

interface TypeErasureOverlayResult {
	newFindings: TypeErasureFinding[];
	/** Whether the file extension was eligible for the overlay. */
	applicable: boolean;
}

/** Public for tests + callers. Strict-typing overlay rule id used in block messages. */
export const STRICT_TYPING_RULE_ID = "strict-typing-overlay";

/** TS/TSX/MTS/CTS file extensions are eligible. JS family is not — `: any`
 *  isn't a JS construct and `@ts-*` directives are no-ops there. */
const JS_TS_EXT = /\.(tsx?|mts|cts)$/;
/** Test files relax the `: any` annotation rule (mocks frequently use it). */
const TEST_FILE = /\.(test|spec|fixture)\.\w+$|__tests__|\/tests?\//;

interface PatternSpec {
	ruleId: string;
	pattern: RegExp;
	message: string;
	skipTestFiles?: boolean;
	/** Optional guard against the original (un-stripped) line. Returns true to keep the match. */
	guard?: (originalLine: string, match: RegExpExecArray) => boolean;
	/** When true, run the matcher against the original line (not the stripped one).
	 *  Required for patterns that legitimately live inside comments — `@ts-ignore`,
	 *  `@ts-expect-error`. The stripper replaces comment bodies with spaces. */
	matchOriginal?: boolean;
}

const PATTERNS: PatternSpec[] = [
	{
		ruleId: "as_any",
		pattern: /\bas\s+any\b/g,
		message:
			"`as any` cast erases types — use a typed assertion, generic, or schema validator.",
	},
	{
		ruleId: "as_unknown_chain",
		pattern: /\bas\s+unknown\s+as\b/g,
		message:
			"`as unknown as T` chain bypasses type checking — narrow with a type guard or runtime validator.",
	},
	{
		ruleId: "unjustified_ts_directive",
		pattern: /@ts-(?:ignore|expect-error)\b([^\n]*)/g,
		message:
			"TypeScript suppression directive without an inline justification — write `// @ts-expect-error: <reason>` so the next reader knows why.",
		matchOriginal: true,
		guard: (_originalLine, match) => {
			// Keep the finding only when the trailing text on the same line
			// does NOT contain a justification. A justification is at least
			// one alphanumeric token after a separator (`:`, `-`, `—`).
			const trailing = match[1] ?? "";
			return !/[:\-—]\s*\S+/.test(trailing);
		},
	},
	{
		ruleId: "bare_any_annotation",
		pattern: /:\s*any\b/g,
		message:
			"Bare `: any` annotation — name the actual shape (interface, generic, or branded type).",
		skipTestFiles: true,
		guard: (originalLine) => {
			// Skip lines that are themselves type-aliasing `any` (rare, but
			// `type AnyLike = any` is the project's deliberate decision).
			return !/^\s*(?:export\s+)?type\s+\w+\s*=/.test(originalLine);
		},
	},
];

function findAll(content: string, filePath: string): TypeErasureFinding[] {
	const stripped = stripAllLiterals(content);
	const origLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const isTestFile = TEST_FILE.test(filePath);
	const findings: TypeErasureFinding[] = [];
	for (const spec of PATTERNS) {
		if (spec.skipTestFiles && isTestFile) continue;
		const targetLines = spec.matchOriginal ? origLines : strippedLines;
		for (let i = 0; i < targetLines.length; i++) {
			const slLine = nonNull(targetLines[i]);
			const origLine = origLines[i] ?? "";
			spec.pattern.lastIndex = 0;
			let m: RegExpExecArray | null = spec.pattern.exec(slLine);
			while (m !== null) {
				if (!spec.guard || spec.guard(origLine, m)) {
					findings.push({
						line: i + 1,
						column: m.index + 1,
						ruleId: spec.ruleId,
						message: spec.message,
						matchKey: `${spec.ruleId}:${origLine.trim()}`,
					});
				}
				m = spec.pattern.exec(slLine);
			}
		}
	}
	return findings;
}

/**
 * Public API — return the type-erasure findings introduced by an edit.
 *
 * Pre-edit content is read from disk by default. Tests pass `options.preContent`
 * to avoid filesystem coupling. When the file doesn't yet exist on disk
 * (new-file Write), every post finding is "new".
 *
 * The diff is a multiset subtract on `(ruleId, trimmed-line-text)`: any post
 * finding without a matching pre finding is reported. Robust against
 * re-ordering edits; conservative about repeated casts within the same line.
 */
export function evaluateTypeErasureOverlay(
	filePath: string,
	postContent: string,
	options?: { preContent?: string | undefined },
): TypeErasureOverlayResult {
	if (!JS_TS_EXT.test(filePath)) return { newFindings: [], applicable: false };

	const post = findAll(postContent, filePath);
	if (post.length === 0) return { newFindings: [], applicable: true };

	let preContent: string | undefined =
		options && Object.hasOwn(options, "preContent") ? options.preContent : undefined;
	if (preContent === undefined && !(options && Object.hasOwn(options, "preContent"))) {
		try {
			if (existsSync(filePath)) preContent = readFileSync(filePath, "utf-8");
		} catch (e) {
			void e;
		}
	}

	if (preContent === undefined) {
		return { newFindings: post, applicable: true };
	}

	const pre = findAll(preContent, filePath);
	const preCounts = new Map<string, number>();
	for (const f of pre) {
		preCounts.set(f.matchKey, (preCounts.get(f.matchKey) ?? 0) + 1);
	}
	const newFindings: TypeErasureFinding[] = [];
	for (const f of post) {
		const remaining = preCounts.get(f.matchKey) ?? 0;
		if (remaining > 0) {
			preCounts.set(f.matchKey, remaining - 1);
		} else {
			newFindings.push(f);
		}
	}
	return { newFindings, applicable: true };
}
