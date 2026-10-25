// First-argument classification for `logger_format_user_input`. The detector
// reads a comment/string-stripped line (string bodies blanked to `""`,
// template literals keep their `${…}` expressions). A source identifier at the
// start of the first argument is a format-string risk only when the argument
// can evaluate to that value. A ternary whose branches are both literals and a
// bare comparison cannot (adversarial review 2026-10-21, round 2).

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

/** Text of the call argument that starts at `from`: up to the depth-0 `,` or closing paren. */
export function firstArgumentText(line: string, from: number): string {
	let depth = 0;
	for (let i = from; i < line.length; i++) {
		const ch = line[i] ?? "";
		if (OPENERS.has(ch)) depth++;
		else if (CLOSERS.has(ch)) {
			if (depth === 0) return line.slice(from, i);
			depth--;
		} else if (ch === "," && depth === 0) return line.slice(from, i);
	}
	return line.slice(from);
}

/** The argument with every character inside a nested bracket pair removed. */
function depthZeroText(arg: string): string {
	let depth = 0;
	let out = "";
	for (const ch of arg) {
		if (OPENERS.has(ch)) depth++;
		else if (CLOSERS.has(ch)) depth--;
		else if (depth === 0) out += ch;
	}
	return out;
}

/** True when `?` at `i` is a ternary operator, not `?.` or `??`. */
function isTernaryMark(text: string, i: number): boolean {
	return text[i] === "?" && text[i + 1] !== "." && text[i + 1] !== "?" && text[i - 1] !== "?";
}

/** Split a depth-0 ternary into [consequent, alternate], or null when there is none. */
function splitTernary(arg: string): [string, string] | null {
	let depth = 0;
	let question = -1;
	let pending = 0;
	for (let i = 0; i < arg.length; i++) {
		const ch = arg[i] ?? "";
		if (OPENERS.has(ch)) depth++;
		else if (CLOSERS.has(ch)) depth--;
		else if (depth !== 0) continue;
		else if (isTernaryMark(arg, i)) {
			if (question === -1) question = i;
			else pending++;
		} else if (ch === ":" && question !== -1) {
			if (pending === 0) return [arg.slice(question + 1, i), arg.slice(i + 1)];
			pending--;
		}
	}
	return null;
}

const LITERAL_RE = /^\s*(?:"[^"]*"|'[^']*'|`[^`]*`)\s*$/;
/** Comparison operators; `=>` (an arrow) is not one. */
const COMPARISON_RE = /[!=]==?|<=?|(?<!=)>=?|\binstanceof\b/;
/** Operators that return an operand rather than a boolean, or assign one. */
const VALUE_RETURNING_RE = /&&|\|\||\?|=>|(?<![=!<>])=(?!=)/;

/**
 * True when the stripped first argument cannot evaluate to a source value: a
 * string or template literal, a ternary whose branches both qualify, or a
 * depth-0 comparison with no short-circuit operator.
 */
export function isNonFormatLoggerArgument(arg: string): boolean {
	if (LITERAL_RE.test(arg)) return true;
	const ternary = splitTernary(arg);
	if (ternary) return isNonFormatLoggerArgument(ternary[0]) && isNonFormatLoggerArgument(ternary[1]);
	const top = depthZeroText(arg);
	return COMPARISON_RE.test(top) && !VALUE_RETURNING_RE.test(top);
}
