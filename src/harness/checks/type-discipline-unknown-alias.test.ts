// Coverage-campaign companion for type-discipline-unknown-alias.ts (Phase 2,
// unit p2u069). The bulk of unknown_type_alias's behavior is exercised in
// the sibling type-discipline.test.ts (shared header, same evidence tier —
// see that file). This file adds ONLY the one case not covered there: the
// outer try/catch around collectUnknownTypeAliases (line ~176) that turns a
// runtime failure inside the recursive same-file alias-chain walk into a
// silent `[]` rather than letting the check crash the caller.

import { describe, expect, it } from "vitest";
import { detectUnknownTypeAlias } from "./type-discipline-unknown-alias.js";

const TS_FILE = "src/lib/data.ts";

// A same-file alias chain long enough to overflow the call stack inside
// `resolvesToUnknown`'s recursion (empirically ~6-10k levels; 60k gives a
// wide, environment-independent margin). Statements are packed many-per-line
// so the file stays well under MAX_LINES_PER_FILE (1500) — this exercises
// the RECURSION depth, not the line-count guard, which is covered elsewhere.
const CHAIN_LENGTH = 60_000;
const STATEMENTS_PER_LINE = 200;

function deepAliasChainContent(n: number): string {
	// A0 = A1; A1 = A2; ...; A(n-1) = An; An = unknown;
	// Declared in THIS order (not reversed) so Map iteration visits A0 first
	// — within collectUnknownTypeAliases's 10-match cap — and resolving A0
	// walks the full depth-n chain before any other alias is even checked.
	const statements: string[] = [];
	for (let i = 0; i < n; i++) {
		statements.push(`type A${i} = A${i + 1};`);
	}
	statements.push(`type A${n} = unknown;`);

	const lines: string[] = [];
	for (let i = 0; i < statements.length; i += STATEMENTS_PER_LINE) {
		lines.push(statements.slice(i, i + STATEMENTS_PER_LINE).join(" "));
	}
	return `${lines.join("\n")}\n`;
}

describe("detectUnknownTypeAlias — recursion-overflow safety", () => {
	it("P: returns [] (not a thrown error) when a same-file alias chain overflows the resolver's recursion depth", () => {
		const content = deepAliasChainContent(CHAIN_LENGTH);
		// A stack overflow inside resolvesToUnknown is a RangeError; the
		// outer try/catch in detectUnknownTypeAlias must swallow it and
		// return [] rather than letting it propagate to the caller (every
		// other quality-check invocation assumes a checker never throws).
		expect(() => detectUnknownTypeAlias(content, TS_FILE)).not.toThrow();
		// The chain DOES resolve to `unknown` at every level — a shallow
		// version of the exact same input (see the sibling positive case in
		// type-discipline.test.ts) reports it. Silently returning `[]` here,
		// rather than the finding a shallow chain would produce, is the
		// discriminating observable: it proves the catch path actually ran
		// (a successful deep resolution would instead report >=1 finding).
		expect(detectUnknownTypeAlias(content, TS_FILE)).toEqual([]);
	});
});
