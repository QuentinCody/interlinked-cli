// Scope-relevance test for count/range claims (line-cap split of ledger.ts).

import type { SpecFacts } from "./types.js";

/** Whether any count/range claim in `facts` binds to a namespace key in `keys`
 *  — the test for whether a file can contribute a count/range finding involving
 *  the scoped file (sol-max #19). Range keys are direct; count keys come through
 *  the merged noun→namespace bindings (covers the D-1 no-local-ids case). */
export function claimsTouchKeys(
	facts: SpecFacts,
	bindings: Map<string, Set<string>>,
	keys: Set<string>,
): boolean {
	for (const c of facts.rangeClaims) {
		if (keys.has(`${c.style} ${c.prefix}`)) return true;
	}
	for (const c of facts.countClaims) {
		const bound = bindings.get(c.nounSingular);
		if (bound) {
			for (const k of bound) if (keys.has(k)) return true;
		}
	}
	return false;
}
