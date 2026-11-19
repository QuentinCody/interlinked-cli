// ===========================================
// claim_liveness — "the doc or commit says X runs; nothing imports X"
// ===========================================
// SPIKE (2026-11-05). Not registered, not wired into verify, no CLI verb.
// Design, measurement and recommendation: docs/reviews/claim-liveness-spike.md.
//
// CLASS: claim-vs-import-graph drift. The 2026-09-02 deletion wave found SEVEN
//   product files whose commit message or design doc said the feature was live
//   while nothing imported them (`git log -S` showed six were never imported,
//   one was reverted and never re-landed). The Jev module
//   `jev/doc-claim-liveness.ts` answers the semantic half with a model; this
//   module is the fully deterministic counterpart: a fixed verb list in the
//   same sentence as a path, plus the import graph the caller supplies.
//
// FIRES WHEN: a sentence (or one table row / list item) of a claim source names
//   a product code file AND contains a liveness verb (LIVENESS_VERB_RE), the
//   named file exists in `files`, is product code (not test / fixture / scratch
//   / docs / generated / `.d.ts`), is not an entry point (caller-supplied set
//   plus ENTRY_SHAPE_RE), and `importers(file)` yields no non-test importer.
// DOES NOT FIRE: the path does not resolve (or resolves to more than one file
//   by suffix); the file is a test, fixture, scratch, docs or generated file;
//   the file is an entry point; any non-test file imports it; the verb and the
//   path sit in different sentences; the sentence carries a negation or
//   historical marker next to the verb (NEGATION_RE, v1); the sentence is a
//   "do not / never / removed" instruction (v1).
// DETERMINISM: fully_deterministic over its inputs. No I/O. The `importers`
//   callback is an input; what it counts (static, `export … from`, dynamic
//   `import()` literal, `require()` literal) is the caller's contract and is
//   documented at the one caller, scripts/scan-claim-liveness.mts.
// CALIBRATION: this repo, 2026-11-05 — see the spike doc's measurement tables.
//   Every regex below is documented where it is declared.
// KNOWN GAPS: a bare basename in backticks (`server.ts`) is not a path and is
//   ignored; a path split across a soft line wrap is missed; a verb inside a
//   code span is still a verb; sentence splitting is punctuation-based.
// HOW TO EXTEND: add a verb to LIVENESS_VERB_RE (and a MUST-FIRE case), or a
//   hedge to NEGATION_RE (and a MUST-NOT-FIRE case); re-run the scan script and
//   append a row to the precision history before changing either.

import { isTestSourcePath } from "./shared-test-classification.js";

/** One unit of prose that may carry a liveness claim: a markdown paragraph
 *  or a whole commit message. `line` is 1-based within `source`. */
export interface ClaimSource {
	/** Markdown file path, or `commit:<sha>`. */
	source: string;
	line: number;
	text: string;
}

export interface ClaimLivenessInput {
	claims: readonly ClaimSource[];
	/** Repo-relative POSIX paths of every file in the tree — the existence oracle. */
	files: readonly string[];
	/** Repo-relative paths of files that reference `file` (any mechanism the
	 *  caller counts). The detector drops test importers and self-imports. */
	importers: (file: string) => readonly string[];
	/** Files reachable without an importer: bin, package exports, setupFiles,
	 *  bundler entries. Path-shape entries (ENTRY_SHAPE_RE) always apply. */
	entryPoints?: readonly string[];
	/** Hedge filter applied per sentence; `null` disables it (the v0
	 *  measurement). Defaults to NEGATION_RE. */
	negation?: RegExp | null;
	/** Liveness verb list; defaults to LIVENESS_VERB_RE. The scan script passes
	 *  a wider list for the iteration-1 measurement. */
	verbs?: RegExp;
	/** Iteration 2: also resolve a backtick BASENAME (`corpus-scan.ts`) when
	 *  exactly one product-code file in `files` carries it. Default false: the
	 *  brief's path grammar is the control. */
	basenames?: boolean;
}

export interface ClaimLivenessFinding {
	source: string;
	/** Line of the claim's paragraph within `source`. */
	line: number;
	/** Resolved repo-relative path the claim names. */
	path: string;
	/** The path text as written in the prose (before suffix resolution). */
	written: string;
	/** The liveness verb that made the sentence a claim. */
	verb: string;
	sentence: string;
	/** Importers the caller reported that the detector discounted as tests. */
	testImporters: number;
}

// ---- Regexes (every one documented) ----

/** Present-tense liveness verbs from the spike brief. `\b` on both sides so
 *  `lives`, `delivered`, `enabled_rules` and `runsOn` do not match. Matched
 *  case-insensitively: docs write "Wired", "LIVE" and "runs" alike. `live in`
 *  is excluded: "its helpers live in `x.ts`" locates a file, it does not
 *  assert the file runs (found writing case N3). */
export const LIVENESS_VERB_RE =
	/\b(?:now runs|runs|wired|live(?! in\b)|enabled|lands|ships|is called|default[- ]on)\b/i;

/** Hedge filter (v1, derived from the v0 false positives in the spike doc):
 *  a sentence whose verb is negated or whose subject is explicitly not current
 *  asserts nothing about today. Placeholder until measured — see the
 *  precision history before trusting any alternative here. */
export const NEGATION_RE = /\b(?:not|never)\b/i;

/** Backtick spans. The content is then validated by CODE_PATH_RE; a span that
 *  is not path-shaped (an identifier, a flag, a command) is ignored. */
const BACKTICK_SPAN_RE = /`([^`\n]+)`/g;

/** A relative code path inside backticks: at least one `/`, a code extension,
 *  optional leading `./`. Segments allow `@` (scoped dirs), `-`, `_`, `.`. */
const CODE_PATH_RE = /^(?:\.\/)?[\w@][\w@.-]*(?:\/[\w@.-]+)+\.(?:[cm]?[jt]sx?)$/;

/** Iteration 2: a bare basename inside backticks (`corpus-scan.ts`). Only a
 *  UNIQUE product-code match resolves (`store.ts` names five files here). */
const CODE_BASENAME_RE = /^[\w@.-]+\.(?:[cm]?[jt]sx?)$/;

/** A bare `src/…` path with a code extension, outside backticks. The
 *  lookbehind refuses a preceding path character (so `cloud/src/x.ts` is read
 *  from its own start, not from `src/`), the lookahead refuses a continuing
 *  word or a further `.ext` (so `src/x.ts.bak` is not `src/x.ts`). */
const BARE_SRC_PATH_RE = /(?<![\w./@-])src\/[\w@.-]+(?:\/[\w@.-]+)*\.(?:[cm]?[jt]sx?)(?![\w-]|\.\w)/g;

/** Code extensions a claim can name. `.d.ts` is excluded separately. */
const CODE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/;

/** Sentence boundary: terminal punctuation, whitespace, then a capital,
 *  backtick, markdown emphasis, bracket or quote — or a semicolon and any
 *  whitespace. A period inside a path (`x.ts is wired`) is followed by a
 *  lowercase word, so it does not split. */
const SENTENCE_BOUNDARY_RE = /(?<=[.!?])\s+(?=[A-Z`*(\["'_])|;\s+/;

/** A line that starts its own unit: a table row or a list item. Other lines
 *  are soft-wrapped continuations of the previous unit. */
const UNIT_START_RE = /^\s*(?:\||[-*+]\s|\d+[.)]\s)/;

/** A table row is ONE claim unit whatever punctuation its cells hold: the
 *  path sits in one cell and the claim in the next (every CLAUDE.md file
 *  table), so splitting a row at a period would separate them. */
const TABLE_ROW_RE = /^\s*\|/;

/** Paths that are product code by shape alone — everything else is not a
 *  candidate (tests, fixtures, scratch, docs, generated, type declarations,
 *  build output, dependency trees). */
const NON_PRODUCT_PATH_RE =
	/\.d\.[cm]?ts$|(?:^|\/)(?:__fixtures__|__mocks__|fixtures?|test-setup|scratch|docs?|dist|build|coverage|node_modules|generated|__generated__)\/|\.(?:gen|generated)\.[cm]?[jt]sx?$/;

/** Entry points by path shape: scripts and bin trees, root tool configs, the
 *  package root index, vitest setup files. Caller-supplied entries extend this. */
const ENTRY_SHAPE_RE = /^(?:scripts|bin)\/|^[^/]+\.config\.[cm]?[jt]sx?$|^src\/index\.[cm]?[jt]sx?$|(?:^|\/)test-setup\//;

// ---- Prose → units ----

/** Split markdown into blank-line-separated paragraphs with their 1-based
 *  start line. Fenced code blocks are dropped whole (a path inside a code
 *  fence is an example, not a claim). Pure; exported for the scan script and
 *  the tests. */
export function splitMarkdownParagraphs(content: string, source: string): ClaimSource[] {
	const out: ClaimSource[] = [];
	const lines = content.split("\n");
	let inFence = false;
	let start = -1;
	let buf: string[] = [];
	const flush = (): void => {
		if (buf.length > 0 && buf.some((l) => l.trim().length > 0)) {
			out.push({ source, line: start, text: buf.join("\n") });
		}
		buf = [];
		start = -1;
	};
	lines.forEach((raw, i) => {
		if (/^\s*(?:```|~~~)/.test(raw)) {
			flush();
			inFence = !inFence;
			return;
		}
		if (inFence) return;
		if (raw.trim() === "") {
			flush();
			return;
		}
		if (start < 0) start = i + 1;
		buf.push(raw);
	});
	flush();
	return out;
}

/** Paragraph → sentence-sized units: table rows whole, list items and prose
 *  split at sentence punctuation. Inline code spans are kept verbatim. */
export function splitIntoSentences(text: string): string[] {
	const units: string[] = [];
	for (const line of text.split("\n")) {
		if (units.length === 0 || UNIT_START_RE.test(line)) units.push(line.trim());
		else units[units.length - 1] = `${units[units.length - 1]} ${line.trim()}`;
	}
	return units
		.flatMap((u) => (TABLE_ROW_RE.test(u) ? [u] : u.split(SENTENCE_BOUNDARY_RE)))
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Every path-shaped mention in a sentence, as written. With `basenames`,
 *  a bare backtick basename is a mention too (resolution decides uniqueness). */
export function extractPathMentions(sentence: string, basenames = false): string[] {
	const seen = new Set<string>();
	for (const m of sentence.matchAll(BACKTICK_SPAN_RE)) {
		const span = (m[1] ?? "").trim();
		if (CODE_PATH_RE.test(span)) seen.add(span.replace(/^\.\//, ""));
		else if (basenames && CODE_BASENAME_RE.test(span)) seen.add(span);
	}
	const stripped = sentence.replace(BACKTICK_SPAN_RE, " ");
	for (const m of stripped.matchAll(BARE_SRC_PATH_RE)) seen.add(m[0]);
	return [...seen];
}

// ---- Path → file ----

/** Exact match, else a unique `/`-anchored suffix match (CLAUDE.md writes
 *  `evaluator/foo.ts` for `src/harness/evaluator/foo.ts`). Ambiguous or
 *  absent ⇒ null: a finding needs one real file. */
export function resolveMention(written: string, files: readonly string[]): string | null {
	if (files.includes(written)) return written;
	if (written.startsWith("src/")) return null;
	const suffix = `/${written}`;
	// A bare basename is matched against product code only: `server.ts` must
	// not be made ambiguous by four fixture copies, nor resolved to one of them.
	const pool = written.includes("/") ? files : files.filter(isProductCodePath);
	const hits = pool.filter((f) => f.endsWith(suffix));
	return hits.length === 1 ? (hits[0] ?? null) : null;
}

/** Product code by path shape: a code extension, not a test, not a path the
 *  NON_PRODUCT_PATH_RE names. */
export function isProductCodePath(path: string): boolean {
	if (!CODE_EXT_RE.test(path)) return false;
	if (NON_PRODUCT_PATH_RE.test(path)) return false;
	if (isTestSourcePath(path)) return false;
	return true;
}

function isTestImporter(importer: string): boolean {
	return isTestSourcePath(importer) || NON_PRODUCT_PATH_RE.test(importer);
}

// ---- Detector ----

/** Pure: fires once per (claim, resolved path) for a liveness sentence whose
 *  named product file has no non-test importer and is not an entry point. */
export function detectClaimLiveness(input: ClaimLivenessInput): ClaimLivenessFinding[] {
	const entries = new Set(input.entryPoints ?? []);
	const negation = input.negation === undefined ? NEGATION_RE : input.negation;
	const verbs = input.verbs ?? LIVENESS_VERB_RE;
	const findings: ClaimLivenessFinding[] = [];
	for (const claim of input.claims) {
		const reported = new Set<string>();
		for (const sentence of splitIntoSentences(claim.text)) {
			const verb = verbs.exec(sentence)?.[0];
			if (!verb || (negation !== null && negation.test(sentence))) continue;
			for (const written of extractPathMentions(sentence, input.basenames === true)) {
				const path = resolveMention(written, input.files);
				if (!path || reported.has(path) || !isProductCodePath(path)) continue;
				if (entries.has(path) || ENTRY_SHAPE_RE.test(path)) continue;
				const importers = input.importers(path).filter((i) => i !== path);
				if (importers.some((i) => !isTestImporter(i))) continue;
				reported.add(path);
				findings.push({
					source: claim.source,
					line: claim.line,
					path,
					written,
					verb,
					sentence,
					testImporters: importers.length,
				});
			}
		}
	}
	return findings;
}
