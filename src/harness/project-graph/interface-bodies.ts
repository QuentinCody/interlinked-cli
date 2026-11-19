// ===========================================
// Project Graph — Interface/Type Body Extraction
// ===========================================
// Extracts the textual body of `interface` and `type` declarations so the
// interface-change-impact check can compare old vs new bodies and detect
// shape changes without parsing the full AST.

import { nonNull } from "../../lib/non-null.js";

/**
 * Public API — consumed by ProjectGraph.indexFile.
 *
 * Extract the body text of interface and type declarations from source content.
 * Returns a map of name → body text for comparison.
 */
export function extractInterfaceBodies(content: string): Map<string, string> {
	const result = new Map<string, string>();
	const lines = content.split("\n");

	let currentName: string | null = null;
	let braceDepth = 0;
	let body = "";

	for (const line of lines) {
		const trimmed = line.trim();

		if (!currentName) {
			// Look for interface/type start
			const ifaceMatch = trimmed.match(/^export\s+interface\s+([\w$]+)/);
			const typeMatch = trimmed.match(/^export\s+type\s+([\w$]+)\s*=\s*\{/);

			if (ifaceMatch) {
				currentName = nonNull(ifaceMatch[1]);
				braceDepth = 0;
				body = "";
			} else if (typeMatch) {
				currentName = nonNull(typeMatch[1]);
				braceDepth = 0;
				body = "";
			}
		}

		if (currentName) {
			body += `${trimmed}\n`;
			braceDepth += (trimmed.match(/\{/g) || []).length;
			braceDepth -= (trimmed.match(/\}/g) || []).length;

			if (braceDepth <= 0 && body.includes("{")) {
				result.set(currentName, body.trim());
				currentName = null;
				body = "";
			}
		}
	}

	return result;
}
