// ============================================================
// redis client footgun detectors
// ============================================================
// Memory leak class: `client.set(key, value)` without an
// expiration option silently leaks data forever. Production
// Redis is finite — every set-without-TTL is a future incident.

import type { InlineMatch } from "../checks/shared.js";
import { balancedArgList, shouldSkipFootgunScan } from "./scan-helpers.js";
import type { LibraryFootgunCheck } from "./types.js";

const REDIS_SET_OPEN_RE = /\b(?:redis|client|cache|kv)\s*\.\s*set\s*\(/g;

function detectSetWithoutExpire(content: string, filePath: string): InlineMatch[] {
	if (shouldSkipFootgunScan(filePath, content)) return [];
	const out: InlineMatch[] = [];
	const lines = content.split("\n");
	REDIS_SET_OPEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null = REDIS_SET_OPEN_RE.exec(content);
	while (m !== null) {
		const openIdx = m.index + m[0].length - 1;
		const args = balancedArgList(content, openIdx);
		if (args !== null) {
			const hasOptions = /\b(?:EX|PX|expirationTtl|expiration|EXAT|PXAT)\b/.test(args);
			const hasLegacyPositional =
				/,\s*["']EX["']\s*,/.test(args) || /,\s*["']PX["']\s*,/.test(args);
			if (!hasOptions && !hasLegacyPositional) {
				const commas = (args.match(/,/g) || []).length;
				if (commas <= 1) {
					const lineNo = content.slice(0, m.index).split("\n").length;
					out.push({
						line: lineNo,
						text: (lines[lineNo - 1] || "").trim().slice(0, 150),
					});
				}
			}
		}
		m = REDIS_SET_OPEN_RE.exec(content);
	}
	return out;
}

export const REDIS_FOOTGUNS: LibraryFootgunCheck[] = [
	{
		id: "redis_set_without_expire",
		name: "redis SET without expiration",
		library: "redis",
		detect: detectSetWithoutExpire,
		fixInstruction:
			"`redis.set(key, value)` without an expiration leaks memory indefinitely. Add `{ EX: <seconds> }` for ttl, or `{ KEEPTTL: true }` if updating an existing key on purpose, or document why a permanent key is correct.",
	},
];
