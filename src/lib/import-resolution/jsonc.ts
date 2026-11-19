// JSON with comments and trailing commas, as `tsconfig.json` and `jsconfig.json` allow.
// Returns null on any syntax error: a config that cannot be read supplies no alias.

const STRING_OR_COMMENT = /"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const STRING_OR_TRAILING_COMMA = /"(?:[^"\\]|\\.)*"|,(?=\s*[\]}])/g;

/** Replace every match that is not a string literal; a string literal stays as written. */
function dropOutsideStrings(text: string, pattern: RegExp): string {
	return text.replace(pattern, match => (match.startsWith('"') ? match : ""));
}

export function parseJsonc(text: string): unknown {
	try {
		const withoutComments = dropOutsideStrings(text.replace(/^﻿/, ""), STRING_OR_COMMENT);
		return JSON.parse(dropOutsideStrings(withoutComments, STRING_OR_TRAILING_COMMA));
	} catch {
		return null;
	}
}
