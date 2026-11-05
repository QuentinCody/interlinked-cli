// ===========================================
// Output parser — Biome (extracted from output-parsers.ts for the line cap)
// ===========================================
// Diagnostic headers: `file:line:col <category> ━━━`. Categories are lint
// rules (`lint/...`), `assist/...` (e.g. `assist/source/organizeImports` —
// unsorted imports/exports), `format`, and `parse`/`syntax`. Two families were
// each missing once and each caused a SILENT fail-open: `parse`/`syntax` (round
// 6) and `assist/*` (finding 2026-06) — when biome's ONLY finding was an assist
// diagnostic the parser returned [] while biome still exited non-zero, so the
// runner reported "no diagnostics parsed — lint NOT validated" and waved the
// edit through (it never caught unsorted imports, which CI `biome check` fails).
// Biome 2 also prints the syntax RULE group as `syntax/<group>/<rule>` (verified
// against 2.4.13: `syntax/correctness/noDuplicatePrivateClassMembers`); the
// alternation accepted only the bare word, so those headers were dropped the
// same silent way (found by the kill-proof census, 2026-11-05). They are
// non-configurable errors in biome, so they are errors here.
// Re-exported through output-parsers.ts — import from there.

import { nonNull } from "../../lib/non-null.js";
import type { CheckResult } from "./types.js";

/** Severity + message for one header category: the parse family (`parse`,
 *  bare `syntax`) and the `syntax/*` rule group are errors; everything else is
 *  a warning carrying the category as its message. */
function classifyRule(rule: string): Pick<CheckResult, "severity" | "message"> {
	if (rule === "parse" || rule === "syntax") return { severity: "error", message: `${rule}: file does not parse` };
	if (rule.startsWith("syntax/")) return { severity: "error", message: `${rule}: syntax error` };
	return { severity: "warning", message: rule };
}

export function parseBiomeOutput(output: string): CheckResult[] {
	const results: CheckResult[] = [];
	for (const line of output.split("\n")) {
		const match = line.match(
			/^(.+?):(\d+):(\d+)\s+(lint\S+|assist\S+|suppressions\S+|format|parse|syntax\S*)\s/,
		);
		if (match) {
			// Every capture group in the header regex is mandatory (no `?`
			// quantifier, no empty branch in the category alternation), so a
			// successful match yields four defined strings. `nonNull` carries that
			// proof into the type instead of a post-match undefined guard that no
			// input can reach (35k generated headers: 0 undefined groups).
			const file = nonNull(match[1]);
			const lineNo = nonNull(match[2]);
			const col = nonNull(match[3]);
			const rule = nonNull(match[4]);
			const { severity, message } = classifyRule(rule);
			results.push({
				tool: "biome",
				severity,
				file,
				line: Number.parseInt(lineNo, 10),
				column: Number.parseInt(col, 10),
				message,
				ruleId: rule,
			});
		}
	}
	return results;
}
