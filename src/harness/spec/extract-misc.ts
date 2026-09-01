// Fenced blocks, path references, declared fact markers, and guarantee-verb
// sentences (spec-facts substrate). Feeds spec_path_ref, declared-marker
// drift, and the claim-tag nudge (docs/design/spec-audit-runtime-checks.md
// §3.1/§3.3, classes B1/D and the zero-FP marker family).

import type {
	ClaimSentence,
	DeclaredFact,
	FencedBlock,
	PathRef,
	PathTense,
} from "./types.js";

// Info string is the FULL rest of the line (round-2 #22): CommonMark allows
// more than one token ("```ts title=\"demo\""); capturing only `\S*` left the
// tail unmatched, failed the whole regex, and missed the opener entirely.
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*(.*)$/;

interface OpenFence {
	startLine: number;
	lang: string;
	char: string;
	len: number;
}

/** CommonMark closing rules: same fence character, at least the opener's
 *  length, and no info string (whitespace-only tail) on the closing line. */
function closesFence(marker: string, info: string, open: OpenFence): boolean {
	return info.trim() === "" && marker[0] === open.char && marker.length >= open.len;
}

/** Handle one fence-marker line: open a block, close it, or (for a
 *  mismatched/shorter/info-carrying fence inside a block) ignore it. */
function stepFenceLine(
	open: OpenFence | null,
	marker: string,
	info: string,
	lineNo: number,
	out: FencedBlock[],
): OpenFence | null {
	if (!open) {
		// lang = first token of the info string.
		const lang = info.trim().split(/\s+/)[0] ?? "";
		return { startLine: lineNo, lang, char: marker[0] ?? "`", len: marker.length };
	}
	if (closesFence(marker, info, open)) {
		out.push({ startLine: open.startLine, endLine: lineNo, lang: open.lang });
		return null;
	}
	return open;
}

/** Fenced code blocks with 1-based inclusive line spans. */
export function extractFencedBlocks(lines: string[]): FencedBlock[] {
	const out: FencedBlock[] = [];
	let open: OpenFence | null = null;
	for (let i = 0; i < lines.length; i++) {
		const m = FENCE_RE.exec(lines[i] ?? "");
		if (!m) continue;
		open = stepFenceLine(open, m[1] ?? "", m[2] ?? "", i + 1, out);
	}
	if (open) {
		// Unterminated fence runs to EOF — treat the remainder as fenced.
		out.push({ startLine: open.startLine, endLine: lines.length, lang: open.lang });
	}
	return out;
}

/** 1-based line numbers covered by any fenced block (fence markers included). */
export function fencedLineSet(blocks: FencedBlock[]): Set<number> {
	const set = new Set<number>();
	for (const b of blocks) {
		for (let n = b.startLine; n <= b.endLine; n++) set.add(n);
	}
	return set;
}

/** Inline code spans on a line: `token`. */
const INLINE_CODE_RE = /`([^`\n]+)`/g;

const PATHY_EXT_RE =
	/\.(?:toml|json|jsonl|sh|ts|tsx|js|mjs|cjs|md|mdx|rs|py|go|yaml|yml|lock|txt|cfg|ini|sql|proto|cedar|html|css)$/i;

/** Whether an inline-code token plausibly names a repo-relative file path. */
function looksLikePath(token: string): boolean {
	if (token.includes(" ") || token.includes("://")) return false;
	if (/[*?{<>]/.test(token)) return false;
	if (token.startsWith("/") || token.startsWith("~")) return false; // absolute — not repo-relative
	if (token.includes("/")) return /[\w.-]\/[\w.-]/.test(token);
	return PATHY_EXT_RE.test(token);
}

const FUTURE_MARKERS =
	/\b(?:will|planned|to be (?:written|created|added)|not yet|todo|future|upcoming|proposed|later|eventually|once|when we|should (?:be|live|contain|hold))\b/i;
const PRESENT_MARKERS =
	/\b(?:exists|lives (?:at|in)|located|see|committed|defined in|declared in|reads|loads|writes to|is at|in-repo|currently|already|contains|holds|stored (?:at|in))\b/i;

/** Tense classification for the sentence (line) around a path mention. */
function classifyTense(line: string): PathTense {
	if (FUTURE_MARKERS.test(line)) return "future";
	if (PRESENT_MARKERS.test(line)) return "present";
	return "unknown";
}

/** Backticked repo-relative paths with a present/future-tense classifier. */
export function extractPathRefs(
	lines: string[],
	fencedLines: Set<number>,
): PathRef[] {
	const out: PathRef[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (fencedLines.has(i + 1)) continue;
		const line = lines[i] ?? "";
		INLINE_CODE_RE.lastIndex = 0;
		for (const m of line.matchAll(INLINE_CODE_RE)) {
			const token = (m[1] ?? "").trim();
			if (!looksLikePath(token)) continue;
			out.push({
				line: i + 1,
				path: token,
				tense: classifyTense(line),
				raw: m[0],
			});
		}
	}
	return out;
}

// <!-- fact:NAME -->value<!-- /fact:NAME --> — same-line declared facts.
// The gen-marker grammar generalized: any doc may declare; the ledger
// enforces agreement everywhere the same NAME appears. Zero-FP by
// construction — this is the only family eligible for pre_block. The value
// class is bounded and excludes "<" (round-2 #2): an unbounded lazy `.*?`
// retried across the suffix from every opener, O(n²) when many openers lack
// closers; capping + stopping at the next "<" makes each attempt local.
const DECLARED_FACT_RE =
	/<!--\s*fact:([a-z0-9_.-]+)\s*-->([^<]{0,2048}?)<!--\s*\/fact:\1\s*-->/g;

/** Declared fact markers (checked inside fences too — markers are meta). */
export function extractDeclaredFacts(lines: string[]): DeclaredFact[] {
	const out: DeclaredFact[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		DECLARED_FACT_RE.lastIndex = 0;
		for (const m of line.matchAll(DECLARED_FACT_RE)) {
			out.push({
				name: m[1] ?? "",
				value: (m[2] ?? "").trim(),
				line: i + 1,
			});
		}
	}
	return out;
}

// Guarantee verbs worth a claim-class tag. Kept tight — every entry is a
// word that audits repeatedly flag as overclaim bait (memo class D).
const CLAIM_VERB_RE =
	/\b(guarantees?|proves?|proven|ensures?|exactly-once|byte-identical|impossible to|never (?:loses|fails|drops)|zero-copy|lock-free|wait-free|tamper-proof)\b/i;

const CLAIM_TAG_RE = /\[claim:\s*(?:theorem|model|runtime|statistical|benchmark)\]/i;

/** Guarantee-verb sentences and whether they carry a [claim: …] tag. */
export function extractClaimSentences(
	lines: string[],
	fencedLines: Set<number>,
): ClaimSentence[] {
	const out: ClaimSentence[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (fencedLines.has(i + 1)) continue;
		const line = lines[i] ?? "";
		const m = CLAIM_VERB_RE.exec(line);
		if (!m) continue;
		out.push({
			line: i + 1,
			verb: (m[1] ?? "").toLowerCase(),
			tagged: CLAIM_TAG_RE.test(line),
			text: line.trim().slice(0, 150),
		});
	}
	return out;
}
