// Check Evidence Contract — attribute a labeled case to the detector it names.
//
// The `cases` dimension credits every labeled case in every test file that
// mentions the detector's function name (resolve.ts). A shared suite therefore
// credits each detector it imports with every case in the file: on 2026-11-05,
// 40 of 297 checks met their floor only through cases that exercise another
// detector (scratch/instruction-files/check-evidence-eval.md §3). The
// `attributed_cases` dimension counts a case for a detector only when the case
// NAMES that detector. A case names detector D (function `fn`, check id `id`)
// when at least one of these holds:
//
//   1. Its own body — the lines from its `it(` / `test(` opener to its end, as
//      `case-parser.ts parseCaseSpans` delimits them — contains `fn` as a whole
//      identifier, or `id` as a whole quoted string literal ("nan_comparison").
//   2. Its title, or the title of an enclosing `describe`, contains `fn` or `id`
//      as a whole word.
//   3. Its file names exactly one registered detector (by function identifier
//      or quoted check id), and that detector is D. Then any file-local helper
//      the case calls can only reach D.
//
// Nothing else counts: an import alone, a mention in a sibling case, or a
// helper module outside the file. A case that reaches D only through an
// imported helper with a neutral name in a multi-detector file is NOT credited.
// That under-count is the conservative direction for a measured dimension.

import { type CaseSpan, parseCaseSpans } from "./case-parser.js";
import { identifiersIn } from "./resolve.js";
import type { LabeledCase } from "./types.js";

/** One detector as the attribution rules see it. */
export interface DetectorRef {
	id: string;
	fn: string;
}

/** The registered detectors: function names, and the function behind each check id. */
export interface RegistryNames {
	fns: ReadonlySet<string>;
	fnById: ReadonlyMap<string, string>;
}

interface FileAttribution {
	lines: string[];
	spans: CaseSpan[];
	/** Registered detector function names the whole file mentions. */
	named: Set<string>;
}

/** Registry names plus a per-file memo, shared across one evidence sweep. */
export interface AttributionContext {
	names: RegistryNames;
	files: Map<string, FileAttribution>;
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function wordRe(name: string): RegExp {
	return new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`);
}

function quotedRe(name: string): RegExp {
	return new RegExp(`(["'\`])${escapeRe(name)}\\1`);
}

/** Build the attribution context for a registry (or a subset of one). */
export function attributionContext(registry: readonly { id: string; fn: { name: string } }[]): AttributionContext {
	const fnById = new Map(registry.map((check) => [check.id, check.fn.name] as const));
	return { names: { fns: new Set(fnById.values()), fnById }, files: new Map() };
}

/** Registered detector function names a source text mentions, by identifier or quoted check id. */
export function detectorsNamedIn(source: string, names: RegistryNames): Set<string> {
	const named = new Set<string>();
	for (const identifier of identifiersIn(source)) {
		if (names.fns.has(identifier)) named.add(identifier);
	}
	for (const match of source.matchAll(/(["'`])([\w.-]+)\1/g)) {
		const fn = names.fnById.get(match[2] ?? "");
		if (fn) named.add(fn);
	}
	return named;
}

/** Rules 1 and 2: the case's own body or titles name the detector. */
function caseNamesDetector(body: string, titles: readonly string[], detector: DetectorRef): boolean {
	const fnWord = wordRe(detector.fn);
	if (fnWord.test(body) || quotedRe(detector.id).test(body)) return true;
	const idWord = wordRe(detector.id);
	return titles.some((title) => fnWord.test(title) || idWord.test(title));
}

function fileAttribution(context: AttributionContext, file: string, source: string): FileAttribution {
	const cached = context.files.get(file);
	if (cached) return cached;
	const parsed = { lines: source.split("\n"), spans: parseCaseSpans(source), named: detectorsNamedIn(source, context.names) };
	context.files.set(file, parsed);
	return parsed;
}

/** Every labeled case in one test file, from the same memoized parse (the `cases` view). */
export function labeledCasesIn(context: AttributionContext, file: string, source: string): LabeledCase[] {
	return fileAttribution(context, file, source).spans.map((span) => span.labeled);
}

/** The labeled cases in one test file that name `detector` (rules 1–3 above). */
export function attributedCasesIn(context: AttributionContext, file: string, source: string, detector: DetectorRef): LabeledCase[] {
	const parsed = fileAttribution(context, file, source);
	const soleDetector = parsed.named.size === 1 && parsed.named.has(detector.fn);
	return parsed.spans
		.filter((span) => {
			if (soleDetector) return true;
			const body = parsed.lines.slice(span.labeled.line - 1, span.endLine).join("\n");
			return caseNamesDetector(body, [span.labeled.title, ...span.describeTitles], detector);
		})
		.map((span) => span.labeled);
}
