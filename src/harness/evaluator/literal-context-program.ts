// ===========================================
// Literal-context classifier — inline interpreter programs
// ===========================================
// For a `node -e '…'` / `python3 -c "…"` / `python3 - <<'PY' … PY` /
// `perl -e` / `ruby -e` program, find the program-level string literals and
// comments (their interior ranges, as indices into the program text), and
// decide whether the program can execute a command at all.
//
// The guarantee the caller relies on: text inside a returned range is data
// to the interpreter, and a program for which `programCanExecute` is false
// has no recognised way to hand that data to a shell. Both functions are
// conservative — an unterminated literal, a `${…}` template, or (for perl
// and ruby) any regex/quote-operator syntax returns `null`, and any
// execution-shaped token anywhere in the program returns `true`.

export type ProgramLang = "js" | "python" | "perl" | "ruby";

/** An interior range [start, end) of a literal or comment in program text. */
export interface ProgramRange {
	start: number;
	end: number;
}

/** Tokens that can run a command (or load code that can) in any of the four
 *  languages. Prose words such as "executed" match on purpose: a false
 *  "can execute" only keeps a block. */
const COMMON_EXEC_TOKENS =
	/child_process|subprocess|\bexec|\bspawn|\bsystem\b|popen|\beval\b|\bfork\b|__import__|importlib|\bgetattr\b|\bcompile\s*\(|\bctypes\b|\bpty\b|Open3|\bqx\b|%x|\bvm\b|worker_threads|\bFunction\s*\(|\bimport\s*\(|process\.binding|process\.dlopen|mainModule|multiprocessing|__builtins__|__subclasses__|__globals__|\bcluster\b|\bglobals\s*\(|\bsyscall\b|readpipe/;

const LANG_EXEC_TOKENS: Record<ProgramLang, RegExp> = {
	js: /\bmodule\b\s*\.|\binspector\b|\bwasi\b/,
	python: /\bos\s*\.\s*(?:exec|spawn|posix_spawn)|\bcommands\b|\bshlex\b/,
	perl: /`|\bopen\b|\bdo\b|\brequire\b/,
	ruby: /`|\bopen\b|\bsend\b|\bpublic_send\b|\bKernel\b|instance_eval|class_eval|\bload\b|\brequire\b/,
};

/** A JS `require(...)` whose argument is not a plain string literal is a
 *  dynamic import that could resolve to `child_process`. */
function hasDynamicRequire(text: string): boolean {
	const all = text.match(/\brequire\b/g)?.length ?? 0;
	const literal = text.match(/\brequire\s*\(\s*(['"])[\w:./@-]+\1\s*\)/g)?.length ?? 0;
	return all !== literal;
}

/** Public API — true when the program could execute a shell command. */
export function programCanExecute(text: string, lang: ProgramLang): boolean {
	if (COMMON_EXEC_TOKENS.test(text)) return true;
	if (LANG_EXEC_TOKENS[lang].test(text)) return true;
	return lang === "js" && hasDynamicRequire(text);
}

interface LexState {
	text: string;
	i: number;
	ranges: ProgramRange[];
	/** Last non-blank character outside a literal (JS regex-literal context). */
	prev: string;
}

class LexUnsure extends Error {}

/** Read a quoted literal that may not span lines; record its interior. */
function readLineString(s: LexState, quote: string, record: boolean): void {
	let k = s.i + 1;
	while (k < s.text.length) {
		const ch = s.text.charAt(k);
		if (ch === "\\") {
			k += 2;
			continue;
		}
		if (ch === "\n") throw new LexUnsure("newline in string");
		if (ch === quote) {
			if (record) s.ranges.push({ start: s.i + 1, end: k });
			s.i = k + 1;
			s.prev = quote;
			return;
		}
		k++;
	}
	throw new LexUnsure("unterminated string");
}

/** Read up to `close` (multi-line allowed); record the interior. */
function readUntil(s: LexState, openLen: number, close: string, record: boolean): void {
	const end = s.text.indexOf(close, s.i + openLen);
	if (end < 0) throw new LexUnsure("unterminated block");
	if (record) s.ranges.push({ start: s.i + openLen, end });
	s.i = end + close.length;
}

function readLineComment(s: LexState, openLen: number): void {
	const nl = s.text.indexOf("\n", s.i);
	const end = nl < 0 ? s.text.length : nl;
	s.ranges.push({ start: s.i + openLen, end });
	s.i = end;
}

/** Characters after which a JS `/` begins a regex literal, not a division. */
const JS_REGEX_PRECEDERS = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

function readJsRegex(s: LexState): void {
	let k = s.i + 1;
	let inClass = false;
	while (k < s.text.length) {
		const ch = s.text.charAt(k);
		if (ch === "\n") throw new LexUnsure("newline in regex");
		if (ch === "\\") k++;
		else if (ch === "[") inClass = true;
		else if (ch === "]") inClass = false;
		else if (ch === "/" && !inClass) {
			s.ranges.push({ start: s.i + 1, end: k });
			s.i = k + 1;
			s.prev = "/";
			return;
		}
		k++;
	}
	throw new LexUnsure("unterminated regex");
}

function readJsTemplate(s: LexState): void {
	let k = s.i + 1;
	while (k < s.text.length) {
		const ch = s.text.charAt(k);
		if (ch === "\\") k++;
		else if (ch === "$" && s.text.charAt(k + 1) === "{") throw new LexUnsure("template expression");
		else if (ch === "`") {
			s.ranges.push({ start: s.i + 1, end: k });
			s.i = k + 1;
			s.prev = "`";
			return;
		}
		k++;
	}
	throw new LexUnsure("unterminated template");
}

function stepJs(s: LexState): void {
	const ch = s.text.charAt(s.i);
	const two = s.text.slice(s.i, s.i + 2);
	if (ch === "'" || ch === '"') readLineString(s, ch, true);
	else if (ch === "`") readJsTemplate(s);
	else if (two === "//") readLineComment(s, 2);
	else if (two === "/*") readUntil(s, 2, "*/", true);
	else if (ch === "/" && JS_REGEX_PRECEDERS.has(s.prev)) readJsRegex(s);
	else {
		if (!/\s/.test(ch)) s.prev = ch;
		s.i++;
	}
}

/** Python string prefix letters immediately before the quote at `s.i`. */
function pythonPrefix(s: LexState): string {
	const m = /[rRbBuUfF]{1,2}$/.exec(s.text.slice(Math.max(0, s.i - 2), s.i));
	if (!m) return "";
	const before = s.text.charAt(s.i - m[0].length - 1);
	return /\w/.test(before) ? "" : m[0];
}

function stepPython(s: LexState): void {
	const ch = s.text.charAt(s.i);
	if (ch === "#") return readLineComment(s, 1);
	if (ch !== "'" && ch !== '"') {
		s.i++;
		return;
	}
	const record = !/[fF]/.test(pythonPrefix(s));
	const triple = ch.repeat(3);
	if (s.text.startsWith(triple, s.i)) readUntil(s, 3, triple, record);
	else readLineString(s, ch, record);
}

function stepPerlRuby(s: LexState): void {
	const ch = s.text.charAt(s.i);
	if (ch === "#" && s.text.charAt(s.i - 1) !== "$") return readLineComment(s, 1);
	if (ch === "'" || ch === '"') return readLineString(s, ch, true);
	s.i++;
}

/** perl/ruby quote operators and regex syntax the lexer does not model. */
const PERL_RUBY_UNMODELLED = /\/|%[qQwWrisI]|\bq[qwr]?\s*[^\w\s]|\b[ms]\s*[{(<[|!#]|<</;

/** Public API — interior ranges of string literals and comments in `text`,
 *  or `null` when the lexer cannot be sure of the program's structure. */
export function programLiteralRanges(text: string, lang: ProgramLang): ProgramRange[] | null {
	if ((lang === "perl" || lang === "ruby") && PERL_RUBY_UNMODELLED.test(text)) return null;
	const step = lang === "js" ? stepJs : lang === "python" ? stepPython : stepPerlRuby;
	const s: LexState = { text, i: 0, ranges: [], prev: "" };
	try {
		while (s.i < text.length) step(s);
		return s.ranges.filter((r) => r.end > r.start);
	} catch (err) {
		if (err instanceof LexUnsure) return null;
		throw err;
	}
}
