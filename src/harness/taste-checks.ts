// ===========================================
// Taste Checks — rule-based code quality checks sourced from Robert C. Martin's essays.
// ===========================================
// Each check follows the same shape as generic-checks.ts:
//   fn(content: string, filePath: string) => InlineMatch[]
// Inline checks only — no cross-file analysis, no LLM inference.

import {
	findBlockEnd,
	getExt,
	type InlineMatch,
	isJsTs,
	isTestFile,
	push,
	stripCommentsAndStrings,
} from "./taste-checks-shared.js";


// Checks 12-21 (commented-out code through duplicate describe) plus their
// arg-list / test-body helpers were extracted to keep this barrel under the
// per-file line cap. Re-exported here so existing importers keep importing
// from "./taste-checks.js" unchanged.
export {
	checkAssertionRoulette,
	checkCommentedOutCode,
	checkConditionalInTest,
	checkDataClump,
	checkDuplicateDescribe,
	checkEmptyCatch,
	checkFunctionArgCount,
	checkMagicNumber,
	checkNonDeterministicTest,
	checkTestWithoutDescription,
} from "./taste-checks-checks-2.js";
// The test-assertion family (checkAssertionFreeTest, checkTautologicalAssertion,
// checkMockingTheSUT, checkPrivateMemberTestAccess) was extracted to keep this
// barrel under the per-file line cap. Re-exported here so existing importers
// keep importing from "./taste-checks.js" unchanged.
export {
	checkAssertionFreeTest,
	checkMockingTheSUT,
	checkPrivateMemberTestAccess,
	checkTautologicalAssertion,
} from "./taste-checks-test-assertions.js";

// ===========================================
// 5. Loop Nesting Depth ≥3
// Uncle Bob, "Loopy" (2020)
// ===========================================

const LOOP_EXTS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".java",
	".c",
	".cpp",
	".cc",
	".cxx",
	".go",
	".rs",
]);
const LOOP_HEADER = /\b(for|while)\s*\(|\bdo\s*\{/;

interface BraceScan {
	braceDepth: number;
	enteredLoopAt: number | null;
	flagAt: number | null;
}

function scanBracesForLoop(
	line: string,
	startDepth: number,
	loopStack: number[],
	pendingLoopLine: number | null,
): BraceScan {
	let depth = startDepth;
	let enteredAt: number | null = null;
	let flagAt: number | null = null;
	for (const ch of line) {
		if (ch === "{") {
			depth++;
			if (pendingLoopLine !== null && enteredAt === null) {
				loopStack.push(depth);
				enteredAt = pendingLoopLine;
				if (loopStack.length >= 3 && flagAt === null) flagAt = pendingLoopLine;
			}
		} else if (ch === "}") {
			while (loopStack.length > 0 && loopStack[loopStack.length - 1] === depth) {
				loopStack.pop();
			}
			depth = Math.max(0, depth - 1);
		}
	}
	return { braceDepth: depth, enteredLoopAt: enteredAt, flagAt };
}

export function checkLoopNestingDepth(content: string, filePath: string): InlineMatch[] {
	if (!LOOP_EXTS.has(getExt(filePath))) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const loopStack: number[] = [];
	let braceDepth = 0;
	let pendingLoopLine: number | null = null;

	for (let i = 0; i < sLines.length; i++) {
		const sLine = sLines[i] ?? "";
		if (LOOP_HEADER.test(sLine)) pendingLoopLine = i;
		const scan = scanBracesForLoop(sLine, braceDepth, loopStack, pendingLoopLine);
		braceDepth = scan.braceDepth;
		if (scan.enteredLoopAt !== null) pendingLoopLine = null;
		if (scan.flagAt !== null && matches.length < 5) {
			push(matches, scan.flagAt, lines, 5);
		}
	}
	return matches;
}

// ===========================================
// 6. Long `else if` Chains
// Uncle Bob, "if-else-switch" (2021)
// ===========================================

const ELSE_IF_CHAIN = /\bif\s*\([^)]*\)[^}]*\}(\s*else\s+if\s*\([^)]*\)[^}]*\}){2,}/g;

export function checkElseIfChain(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	for (const m of stripped.matchAll(ELSE_IF_CHAIN)) {
		if (matches.length >= 5) break;
		const offset = m.index;
		const lineIdx = (stripped.slice(0, offset).match(/\n/g) || []).length;
		push(matches, lineIdx, lines, 5);
	}
	return matches;
}

// ===========================================
// 7. Duplicate Switch Discriminant
// Uncle Bob, "if-else-switch" (2021)
// ===========================================

const SWITCH_DISC = /\bswitch\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\)/g;
const DISC_TAIL = /\.(kind|type|tag|variant|_tag)$/;

export function checkDuplicateSwitchDiscriminant(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Map<string, number>();

	for (let i = 0; i < sLines.length && matches.length < 5; i++) {
		const sLine = sLines[i] ?? "";
		for (const m of sLine.matchAll(SWITCH_DISC)) {
			const disc = m[1];
			if (disc === undefined || !DISC_TAIL.test(disc)) continue;
			if (seen.has(disc)) {
				push(matches, i, lines, 5);
			} else {
				seen.set(disc, i);
			}
		}
	}
	return matches;
}

// ===========================================
// 8. Hybrid Class (public fields + behavioral methods)
// Uncle Bob, "Classes vs. Data Structures" (2019)
// ===========================================

const CLASS_DECL = /\bclass\s+[A-Za-z_$][\w$]*\s*(?:extends\s+\S+\s*)?\{/;
const CLASS_ACCESSOR_OR_CTOR = /^(?:async\s+)?(constructor|get|set)\b/;
const CLASS_METHOD = /^(?:async\s+|\*\s*)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/;
const CLASS_FIELD =
	/^(?:public\s+)?[A-Za-z_$][\w$]*\s*[?!]?\s*(?::\s*[^;=(]+)?\s*(?:=\s*[^;]*)?\s*;?\s*$/;
const CLASS_MEMBER_SKIP = /^(readonly|private|protected|static\s+readonly)\b/;

type MemberKind = "field" | "method" | "other";

function classifyMember(raw: string): MemberKind {
	const ln = raw.trim();
	if (!ln || CLASS_MEMBER_SKIP.test(ln) || CLASS_ACCESSOR_OR_CTOR.test(ln)) return "other";
	if (CLASS_METHOD.test(ln)) return "method";
	if (CLASS_FIELD.test(ln) && !ln.includes("(")) return "field";
	return "other";
}

function isHybrid(bodyLines: string[]): boolean {
	let hasField = false;
	let hasMethod = false;
	for (const ln of bodyLines) {
		const kind = classifyMember(ln);
		if (kind === "field") hasField = true;
		else if (kind === "method") hasMethod = true;
		if (hasField && hasMethod) return true;
	}
	return false;
}

export function checkHybridClass(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	let i = 0;
	while (i < sLines.length && matches.length < 5) {
		const sLine = sLines[i] ?? "";
		if (!CLASS_DECL.test(sLine)) {
			i++;
			continue;
		}
		// Cloudflare DurableObject (and WorkerEntrypoint) base classes inherently
		// combine state (SQLite via this.ctx.storage) and behavior (RPC methods)
		// — that's the design center, not a hybrid-class smell.
		if (/\bextends\s+(DurableObject|WorkerEntrypoint)\b/.test(sLine)) {
			const end = findBlockEnd(sLines, i);
			i = end + 1;
			continue;
		}
		const end = findBlockEnd(sLines, i);
		if (isHybrid(sLines.slice(i + 1, end))) push(matches, i, lines, 5);
		i = end + 1;
	}
	return matches;
}

// ===========================================
// 9. Fuzzy-Responsibility Names (low confidence)
// ===========================================

const FUZZY_NAME =
	/\b(class|interface|type)\s+([A-Z][A-Za-z0-9]*(Manager|Helper|Utils?|Service|Handler|Processor|Wrapper))\b/;

export function checkFuzzyResponsibilityName(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < sLines.length && matches.length < 5; i++) {
		if (FUZZY_NAME.test(sLines[i] ?? "")) push(matches, i, lines, 5);
	}
	return matches;
}

// ===========================================
// 10. Law of Demeter (Train Wrecks)
// ===========================================

const TRAIN_WRECK = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\?\.[A-Za-z_$][\w$]*){4,}/;

export function checkLawOfDemeter(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath) || isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < sLines.length && matches.length < 5; i++) {
		const sLine = sLines[i] ?? "";
		if (/^\s*(?:\/\/|\*|\/\*)/.test(lines[i] ?? "")) continue; // comment line belt-and-braces
		const m = TRAIN_WRECK.exec(sLine);
		if (!m) continue;
		if (m[0].startsWith("import.meta.")) continue;
		if (sLine.includes("Object.prototype.")) continue;
		// Cloudflare Worker / DurableObject canonical access: `this.ctx.storage.sql.exec(...)`,
		// `this.ctx.storage.put(...)`, `this.ctx.exports.facetName.method()`. The base
		// class exposes this exact API shape — DO code can't and shouldn't flatten it.
		if (m[0].startsWith("this.ctx.")) continue;
		push(matches, i, lines, 5);
	}
	return matches;
}

// ===========================================
// 11. Flag Arguments
// Clean Code (Ch. 3)
// ===========================================

const FLAG_POSITIONAL = /\b[A-Za-z_$][\w$]*\s*\(\s*[^(),]+?\s*,\s*(true|false)\s*[),]/;
const FLAG_OBJECT =
	/\b[A-Za-z_$][\w$]*\s*\(\s*[^()]*?\{[^{}]*\b[A-Za-z_$][\w$]*\s*:\s*(?:true|false)\b[^{}]*\}/;
const FLAG_SAFE_BUILTINS =
	/\b(setAttribute|setItem|JSON\.stringify|removeEventListener|addEventListener|Array\.from|Object\.defineProperty|Reflect\.defineProperty|hasOwnProperty|localStorage|sessionStorage|Boolean|mkdir|mkdirSync|writeFile|writeFileSync|readFile|readFileSync|appendFile|appendFileSync|rm|rmSync|stat|statSync|lstat|lstatSync|access|accessSync|open|openSync|close|closeSync|chmod|chmodSync|copyFile|copyFileSync|rename|renameSync|unlink|unlinkSync|readdir|readdirSync|realpath|realpathSync|utimes|utimesSync|symlink|symlinkSync|spawn|spawnSync|exec|execSync|execFile|execFileSync|Reflect\.get|Reflect\.set)\s*\(/;

export function checkFlagArgument(content: string, filePath: string): InlineMatch[] {
	if (!isJsTs(filePath) || isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < sLines.length && matches.length < 8; i++) {
		const line = sLines[i] ?? "";
		if (/^\s*(return|const|let|var)\s+/.test(line)) continue;
		if (FLAG_SAFE_BUILTINS.test(line)) continue;
		if (FLAG_POSITIONAL.test(line) || FLAG_OBJECT.test(line)) push(matches, i, lines, 8);
	}
	return matches;
}

