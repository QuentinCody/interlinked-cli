// Where does a literal delay in a test file sit? (hardcoded_timeout_in_tests)
//
// A literal delay is a "wait" only when it runs in the TEST'S OWN control
// flow: the it()/test()/hook callback body, a promise executor or `.then`
// continuation inside it, or a helper the test calls. A delay inside a
// callback handed to some OTHER call inside a test — `bench.add('foo',
// async () => { await sleep(50) })`, a `z.codec(..., { decode: async () =>
// { ... } })` hook, a `vi.fn(async () => ...)` implementation — is a
// workload or fixture behavior the system under test runs. The test never
// waits on it; it is the measured input (2026-10-21 cross-repo
// falsification, tinybench + zod: 10/10 such hits were false positives).
//
// Lexical, offset-based: one forward scan over comment/string-blanked text
// (`stripPreservingOffsets`) keeps a bracket stack, and each delay offset is
// classified from the stack snapshot, innermost frame outward.
//
// A function that is a property (or method) of an object literal — `const
// storage = { getItem: async () => { await sleep(10); … } }` — or an arrow
// assigned to a member (`storage.getItem = async () => { … }`) is a fake
// implementation wherever it sits (zustand tests/persistAsync.test.tsx).
// A delay with no enclosing test/suite/hook frame at all is "helper": its
// caller decides whether it is a wait.
//
// KNOWN GAPS: an unknown call with no enclosing test frame is not treated as
// a SUT (it could equally be a custom test wrapper, `withServer(async () =>
// { await sleep(500) })`), so a module-level `bench.add(...)` workload is
// "helper", not "sut-callback". A `function f(): T {` body with a
// return-type annotation is not recognised as a function boundary, which
// errs toward "wait".

/** Calls whose callback IS the test's own flow (test/suite/hook roots). */
const TEST_ROOTS = new Set([
	"it",
	"test",
	"describe",
	"suite",
	"context",
	"specify",
	"fit",
	"xit",
	"fdescribe",
	"xdescribe",
	"beforeEach",
	"beforeAll",
	"afterEach",
	"afterAll",
]);

/**
 * Calls whose callback runs inline in the caller's flow (promise plumbing,
 * timers, act/waitFor/expect wrappers). A delay inside them belongs to the
 * enclosing function, so the walk continues outward.
 */
const PASSTHROUGH_CALLEES = new Set([
	"Promise",
	"then",
	"catch",
	"finally",
	"all",
	"allSettled",
	"race",
	"any",
	"setTimeout",
	"setImmediate",
	"setInterval",
	"nextTick",
	"queueMicrotask",
	"act",
	"waitFor",
	"expect",
	"step",
]);

const CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "with"]);
const NON_CALL_KEYWORDS = new Set([
	...CONTROL_KEYWORDS,
	"return",
	"await",
	"typeof",
	"void",
	"yield",
	"in",
	"of",
	"function",
	"new",
	"delete",
	"instanceof",
]);

interface Frame {
	open: "(" | "{" | "[";
	/** Dotted callee chain for a call paren (`bench.add` → ["bench","add"]). */
	chain: string[] | null;
	/** Keyword before a non-call paren (`if`, `for`, …). */
	keyword: string | null;
	/** `{` that opens a function body. */
	fnBody: boolean;
	/** `{` that opens a `while (…)` / `do` loop body (a predicate poll). */
	loopBody: boolean;
	/** `{` that opens an object literal (after `=`, `(`, `,`, `:`, `[`, `?`, `return`). */
	objectLiteral: boolean;
	/** `{` body of an arrow assigned to a member (`storage.getItem = async () => {`). */
	memberAssigned: boolean;
	/** An `=>` at this frame's top level since the last `,` / `;`. */
	arrow: boolean;
	/** Index of the opening bracket. */
	start: number;
}

/** Bracket stack plus "directly follows `while (…)`" at one offset. */
interface Snapshot {
	stack: Frame[];
	bracelessPoll: boolean;
}

/** Where a literal delay sits relative to the test's own control flow. */
export type DelayContext = "wait" | "helper" | "sut-callback" | "poll-loop";

const OBJECT_LITERAL_PRECEDERS = new Set(["=", "(", ",", ":", "[", "?"]);

function frameOf(open: Frame["open"], fields: Partial<Frame> = {}): Frame {
	const base: Frame = {
		open,
		chain: null,
		keyword: null,
		fnBody: false,
		loopBody: false,
		objectLiteral: false,
		memberAssigned: false,
		arrow: false,
		start: -1,
	};
	return { ...base, ...fields };
}

interface Closed {
	start: number;
	end: number;
	chain: string[] | null;
	keyword: string | null;
}

const IDENT_CHAR_RE = /[\w$]/;

function prevNonSpace(text: string, from: number): number {
	let j = from;
	while (j >= 0 && /\s/.test(text.charAt(j))) j--;
	return j;
}

function readIdentBackward(text: string, end: number): { word: string; start: number } | null {
	let s = end;
	while (s >= 0 && IDENT_CHAR_RE.test(text.charAt(s))) s--;
	if (s === end) return null;
	return { word: text.slice(s + 1, end + 1), start: s + 1 };
}

/** Dotted member chain ending at index `end` (outermost segment first). */
function memberChainBackward(text: string, end: number): string[] | null {
	const first = readIdentBackward(text, end);
	if (!first) return null;
	const chain = [first.word];
	let cursor = first.start - 1;
	for (;;) {
		const dot = prevNonSpace(text, cursor);
		if (text.charAt(dot) !== ".") break;
		const beforeDot = text.charAt(dot - 1) === "?" ? dot - 2 : dot - 1;
		const next = readIdentBackward(text, prevNonSpace(text, beforeDot));
		if (!next) break;
		chain.unshift(next.word);
		cursor = next.start - 1;
	}
	return chain;
}

function openParen(text: string, i: number, lastClosed: Closed | null): Frame {
	const j = prevNonSpace(text, i - 1);
	const frame = frameOf("(", { start: i });
	if (text.charAt(j) === ")" && lastClosed?.end === j) {
		// Curried call: `it.each(table)(name, fn)` inherits the callee.
		frame.chain = lastClosed.chain;
		return frame;
	}
	const chain = memberChainBackward(text, j);
	if (!chain) return frame;
	const last = chain[chain.length - 1] ?? "";
	if (chain.length === 1 && NON_CALL_KEYWORDS.has(last)) frame.keyword = last;
	else frame.chain = chain;
	return frame;
}

function isFunctionBrace(text: string, i: number, lastClosed: Closed | null): boolean {
	const j = prevNonSpace(text, i - 1);
	if (text.charAt(j) === ">" && text.charAt(j - 1) === "=") return true;
	if (text.charAt(j) !== ")" || lastClosed?.end !== j) return false;
	return !(lastClosed.keyword !== null && CONTROL_KEYWORDS.has(lastClosed.keyword));
}

/** True when index `j` is the `)` that closed a `while (…)` header. */
function closesWhileHeader(text: string, j: number, lastClosed: Closed | null): boolean {
	return text.charAt(j) === ")" && lastClosed?.end === j && lastClosed.keyword === "while";
}

function braceFrame(text: string, i: number, state: ScanState): Frame {
	const { lastClosed } = state;
	const j = prevNonSpace(text, i - 1);
	const loopBody = closesWhileHeader(text, j, lastClosed) || readIdentBackward(text, j)?.word === "do";
	const fnBody = isFunctionBrace(text, i, lastClosed);
	const prev = text.charAt(j);
	const objectLiteral =
		!fnBody && (OBJECT_LITERAL_PRECEDERS.has(prev) || readIdentBackward(text, j)?.word === "return");
	const memberAssigned = fnBody && prev === ">" && state.arrowMember;
	return frameOf("{", { fnBody, loopBody, objectLiteral, memberAssigned });
}

/**
 * At the `=>` at index `i`: is this arrow the right-hand side of a member
 * assignment (`obj.prop = async (x) =>`)? Such a function replaces a method
 * on a fake/stub object.
 */
function isMemberAssignedArrow(text: string, i: number, lastClosed: Closed | null): boolean {
	const j = prevNonSpace(text, i - 1);
	const params = text.charAt(j) === ")" && lastClosed?.end === j ? lastClosed.start : readIdentBackward(text, j)?.start;
	if (params === undefined) return false;
	let k = prevNonSpace(text, params - 1);
	const word = readIdentBackward(text, k);
	if (word?.word === "async") k = prevNonSpace(text, word.start - 1);
	if (text.charAt(k) !== "=" || "=!<>".includes(text.charAt(k - 1))) return false;
	return (memberChainBackward(text, prevNonSpace(text, k - 1))?.length ?? 0) >= 2;
}

/** `while (cond) await delay(25)` — the delay is the braceless loop body. */
function isBracelessPoll(text: string, offset: number, lastClosed: Closed | null): boolean {
	let j = prevNonSpace(text, offset - 1);
	const word = readIdentBackward(text, j);
	if (word?.word === "await") j = prevNonSpace(text, word.start - 1);
	return closesWhileHeader(text, j, lastClosed);
}

interface ScanState {
	stack: Frame[];
	lastClosed: Closed | null;
	/** Whether the most recent `=>` was a member-assigned arrow. */
	arrowMember: boolean;
}

/** Apply the character at `i` to the bracket stack. */
function step(text: string, i: number, state: ScanState): void {
	const ch = text.charAt(i);
	const { stack } = state;
	const top = stack[stack.length - 1];
	if (ch === "(") stack.push(openParen(text, i, state.lastClosed));
	else if (ch === "{") stack.push(braceFrame(text, i, state));
	else if (ch === "[") stack.push(frameOf("["));
	else if (ch === ")" || ch === "}" || ch === "]") {
		const popped = stack.pop();
		if (ch === ")") state.lastClosed = closedOf(popped, i);
	} else if (top && (ch === "," || ch === ";")) top.arrow = false;
	else if (ch === "=" && text.charAt(i + 1) === ">") {
		state.arrowMember = isMemberAssignedArrow(text, i, state.lastClosed);
		if (top) top.arrow = true;
	}
}

function closedOf(frame: Frame | undefined, end: number): Closed {
	return { start: frame?.start ?? -1, end, chain: frame?.chain ?? null, keyword: frame?.keyword ?? null };
}

/** Bracket stack snapshot at each requested offset (ascending). */
function snapshotsAt(text: string, offsets: number[]): Snapshot[] {
	const out: Snapshot[] = [];
	const state: ScanState = { stack: [], lastClosed: null, arrowMember: false };
	let k = 0;
	for (let i = 0; k < offsets.length && i <= text.length; i++) {
		while (k < offsets.length && offsets[k] === i) {
			out.push({ stack: state.stack.map((f) => ({ ...f })), bracelessPoll: isBracelessPoll(text, i, state.lastClosed) });
			k++;
		}
		step(text, i, state);
	}
	return out;
}

type CallKind = "test" | "passthrough" | "other";

function callKind(chain: string[]): CallKind {
	if (TEST_ROOTS.has(chain[0] ?? "")) return "test";
	if (PASSTHROUGH_CALLEES.has(chain[chain.length - 1] ?? "")) return "passthrough";
	return "other";
}

/**
 * Classify one snapshot, innermost frame outward:
 * - "poll-loop": the delay is the interval of a `while`/`do` predicate poll
 *   in its own function (the fix the finding recommends, not a fixed wait);
 * - "sut-callback": it sits inside a callback handed to a non-test call that
 *   itself sits inside a test/suite/hook callback, or inside a function that
 *   is an object-literal property or is assigned to a member
 *   (`storage.getItem = async () => {…}`) — a workload or fake implementation the
 *   system under test runs, not a wait in the test's own flow;
 * - "helper": inside a function with no enclosing test/suite/hook frame;
 * - "wait": in a test/suite/hook body, or a bare top-level statement.
 */
function classifySnapshot(snap: Snapshot): DelayContext {
	if (snap.bracelessPoll) return "poll-loop";
	const walk: Walk = { fnBoundary: false, handedToSut: false };
	for (const frame of [...snap.stack].reverse()) {
		const verdict = frame.open === "{" ? visitBrace(frame, walk) : visitParenOrBracket(frame, walk);
		if (verdict) return verdict;
	}
	return walk.fnBoundary || walk.handedToSut ? "helper" : "wait";
}

/** Walk state between the delay and the frame being visited. */
interface Walk {
	/** A function boundary lies between the delay and this frame. */
	fnBoundary: boolean;
	/** The delay's callback was handed to a non-test call. */
	handedToSut: boolean;
}

function visitBrace(frame: Frame, walk: Walk): DelayContext | null {
	if (frame.loopBody && !walk.fnBoundary && !walk.handedToSut) return "poll-loop";
	if (frame.objectLiteral && (walk.fnBoundary || frame.arrow)) return "sut-callback";
	if (frame.memberAssigned) return "sut-callback";
	if (frame.fnBody) walk.fnBoundary = true;
	return null;
}

function visitParenOrBracket(frame: Frame, walk: Walk): DelayContext | null {
	const inCallback = walk.fnBoundary || frame.arrow;
	if (frame.open !== "(" || frame.chain === null) {
		walk.fnBoundary = inCallback;
		return null;
	}
	const kind = callKind(frame.chain);
	if (kind === "test") return walk.handedToSut ? "sut-callback" : "wait";
	if (kind === "other" && inCallback) walk.handedToSut = true;
	walk.fnBoundary = false;
	return null;
}

/**
 * For each delay offset in `stripped` (offset-preserving blanked text,
 * offsets ascending), where the delay sits relative to the test's own
 * control flow. Only "wait" is a hardcoded sleep the test blocks on.
 */
export function classifyLiteralDelays(stripped: string, offsets: number[]): DelayContext[] {
	return snapshotsAt(stripped, offsets).map(classifySnapshot);
}
