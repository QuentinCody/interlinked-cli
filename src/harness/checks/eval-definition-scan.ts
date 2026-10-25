// eval_usage helper: can a class / interface / object MEMBER start at this
// point? eval_usage reads `eval(...): T` as a member signature (not a call)
// only when the code before `eval` ends where a member may start. A call
// `eval(x) :` exists only as a ternary branch or a `case` test, so the code
// before it always ends with an operator or an operator keyword. A member
// follows a separator, a modifier, a decorator, or (ASI style, no semicolons)
// the end of the previous member: a value, a `)`, a `]` or a type.
// Found by the 2026-10-22 round-3 adversarial review of eval_usage
// (scratch/2026-10-21-round3/eval_usage.round3.probe.mts).

// Words that continue an expression: `c ? await\n eval(x) : y` is a call.
const OPERATOR_KEYWORDS = new Set([
	"as",
	"asserts",
	"await",
	"case",
	"default",
	"delete",
	"do",
	"else",
	"extends",
	"in",
	"instanceof",
	"is",
	"keyof",
	"new",
	"of",
	"return",
	"satisfies",
	"throw",
	"typeof",
	"void",
	"yield",
]);
const MEMBER_SEPARATOR = /[{};,]$/;
const MODIFIER =
	/(?<![\w$.])(?:public|private|protected|static|abstract|async|override|declare|readonly|get|set|accessor)$/;
// `void` as a TYPE closes a member signature: `run(): void`, `cb: () => void`,
// `x: T | void`. Anywhere else it is the `void` operator.
const VOID_TYPE = /(?:[:|]|=>)\s*void$/;
// Text inside `<...>` that a type argument list never holds but a comparison
// chain does (`a < b && c > d`).
const NOT_TYPE_ARGUMENTS = /&&|\|\||[=!]=|[<>]=|[-+*/%!?]/;
// Enough trailing context for every rule below; keeps the `$`-anchored
// regexes linear in the tail, not in the whole file.
const TAIL = 256;

/** A separator or a modifier keyword ends `head` (the strict, no-ASI test). */
function separatorOrModifier(head: string): boolean {
	return head === "" || MEMBER_SEPARATOR.test(head) || MODIFIER.test(head);
}

/** True when `head` ends with a generic close `Name<...>` on its last line. */
function endsWithTypeArguments(head: string): boolean {
	let depth = 0;
	for (let i = head.length - 1; i >= 0; i--) {
		const ch = head[i];
		if (ch === "\n") return false;
		if (ch === ">" && head[i - 1] !== "=") depth++;
		else if (ch === "<" && --depth === 0) {
			const inner = head.slice(i + 1, -1);
			return !NOT_TYPE_ARGUMENTS.test(inner.replaceAll("=>", " ")) && /[\w$]\s*$/.test(head.slice(0, i));
		}
	}
	return false;
}

/** True when the last word of `head` ends a member, not an expression. */
function wordEndsMember(head: string): boolean {
	const word = /[\w$]+$/.exec(head)?.[0] ?? "";
	if (word === "void") return VOID_TYPE.test(head);
	return !OPERATOR_KEYWORDS.has(word);
}

/**
 * True when a class / interface / object member may start right after
 * `head` (the stripped code before a member name, trailing whitespace
 * trimmed). False whenever an expression may continue there, so a call
 * that follows `head` is never read as a definition.
 */
export function memberMayStartAfter(head: string): boolean {
	const tail = head.slice(-TAIL);
	const last = tail.at(-1);
	if (last === undefined || separatorOrModifier(tail)) return true;
	// A generator member `*eval()`: no ASI happens before `*`, so only a
	// separator or a modifier may precede it.
	if (last === "*") return separatorOrModifier(tail.slice(0, -1).trimEnd());
	if (last === ")" || last === "]" || last === '"' || last === "'" || last === "`") return true;
	if (last === ">") return endsWithTypeArguments(tail);
	if (/[\w$]/.test(last)) return wordEndsMember(tail);
	return false;
}
