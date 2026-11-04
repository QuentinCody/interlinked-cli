// Semantic graph — unit extraction. One file in, its units out: functions (via the
// function-token analyzer), the doc comment directly above each function, it()/test()
// blocks, and markdown sections. Deterministic and offline; nothing here judges.
// Contract: ./types.ts.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { findCallSpan } from "../checks/test-hygiene-shared.js";
import { computeFunctionTokens, type FunctionTokenEntry } from "../function-tokens/index.js";
import { extractTestBlocks } from "../jev/test-title-body.js";
import { defaultSemanticTeamConfig } from "../semantic/config.js";
import { discoverSemanticSources } from "../semantic/index-discovery.js";
import type { SemanticTeamConfig } from "../semantic/types.js";
import { matchesAnyGlob } from "../../lib/path-glob.js";
import { DEFAULT_SCOPE } from "./relationships.js";
import type { Unit, UnitKind } from "./types.js";

/** A markdown section's text is capped here: a packet carries the text, and a
 *  5,000-line README chapter would dwarf every candidate beside it. */
export const DOC_SECTION_TEXT_CAP = 4_000;

const DOC_WALK_SKIP: ReadonlySet<string> = new Set([
	"node_modules",
	"dist",
	".interlinked",
	"scratch",
	".git",
]);
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^\s*(```|~~~)/;

export interface RepoUnitsOptions {
	/** Walk every markdown file outside vendored directories. Default true. */
	includeDocs?: boolean;
	/** Semantic team config for code discovery; its globs are replaced by `include` / `exclude`. */
	config?: SemanticTeamConfig;
	/** Repo-relative globs a file must match (code and markdown alike); default `DEFAULT_SCOPE.include`. */
	include?: string[];
	/** Repo-relative globs that remove a file; default `DEFAULT_SCOPE.exclude`. */
	exclude?: string[];
}

export function unitId(file: string, kind: UnitKind, name: string, line: number): string {
	return `${file}#${kind}:${name}@${line}`;
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function slashPath(path: string): string {
	return path.replace(/\\/g, "/");
}

function makeUnit(file: string, kind: UnitKind, name: string, line: number, endLine: number, text: string): Unit {
	return { id: unitId(file, kind, name, line), kind, file, name, line, endLine, text, hash: sha256(text) };
}

/** Lines `from..to` (1-based, inclusive) joined with "\n". */
function sliceLines(lines: readonly string[], from: number, to: number): string {
	return lines.slice(from - 1, to).join("\n");
}

/** The comment block whose last line sits directly above `line`, as [start, end] lines, or null. */
function docCommentSpan(lines: readonly string[], line: number): [number, number] | null {
	const end = line - 1;
	const last = lines[end - 1]?.trim() ?? "";
	if (last.endsWith("*/")) {
		for (let start = end; start >= 1; start--) {
			if (lines[start - 1]?.trimStart().startsWith("/*")) return [start, end];
		}
		return null;
	}
	if (!last.startsWith("//")) return null;
	let start = end;
	while (start > 1 && lines[start - 2]?.trimStart().startsWith("//")) start--;
	return [start, end];
}

function functionUnits(file: string, lines: readonly string[], entries: readonly FunctionTokenEntry[]): Unit[] {
	const out: Unit[] = [];
	for (const entry of entries) {
		if (entry.identityKind !== "named") continue;
		const span = docCommentSpan(lines, entry.line);
		if (span) {
			out.push(makeUnit(file, "doc_comment", entry.qualifiedName, span[0], span[1], sliceLines(lines, span[0], span[1])));
		}
		out.push(makeUnit(file, "function", entry.qualifiedName, entry.line, entry.endLine, sliceLines(lines, entry.line, entry.endLine)));
	}
	return out;
}

/** 1-based line of the character offset. */
function lineAt(content: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset; i++) if (content.charCodeAt(i) === 10) line++;
	return line;
}

function lineStartOffset(content: string, line: number): number {
	let offset = 0;
	for (let current = 1; current < line; current++) {
		offset = content.indexOf("\n", offset) + 1;
	}
	return offset;
}

function testUnits(file: string, content: string, lines: readonly string[]): Unit[] {
	const out: Unit[] = [];
	for (const block of extractTestBlocks(content)) {
		const openParen = content.indexOf("(", lineStartOffset(content, block.line));
		const span = openParen < 0 ? null : findCallSpan(content, openParen + 1);
		if (!span) continue;
		const endLine = lineAt(content, span.end);
		out.push(makeUnit(file, "test", block.title, block.line, endLine, sliceLines(lines, block.line, endLine)));
	}
	return out;
}

interface Heading {
	level: number;
	name: string;
	line: number;
}

function markdownHeadings(lines: readonly string[]): Heading[] {
	const headings: Heading[] = [];
	let fenced = false;
	lines.forEach((raw, index) => {
		if (FENCE_RE.test(raw)) {
			fenced = !fenced;
			return;
		}
		const m = fenced ? null : HEADING_RE.exec(raw);
		if (m?.[1] && m[2]) headings.push({ level: m[1].length, name: m[2], line: index + 1 });
	});
	return headings;
}

function docSectionUnits(file: string, lines: readonly string[]): Unit[] {
	const headings = markdownHeadings(lines);
	return headings.map((heading, index) => {
		const next = headings.slice(index + 1).find((h) => h.level <= heading.level);
		const endLine = next ? next.line - 1 : lines.length;
		const text = sliceLines(lines, heading.line, endLine).slice(0, DOC_SECTION_TEXT_CAP);
		return makeUnit(file, "doc_section", heading.name, heading.line, endLine, text);
	});
}

function sortUnits(units: Unit[]): Unit[] {
	return units.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/** Every unit of one file. `file` is repo-relative (made so from `cwd` when absolute). */
export function extractUnits(file: string, content: string, cwd?: string): Unit[] {
	const rel = slashPath(cwd !== undefined && isAbsolute(file) ? relative(cwd, file) : file);
	const lines = content.split(/\r?\n/);
	if (rel.toLowerCase().endsWith(".md")) return docSectionUnits(rel, lines);
	const entries = computeFunctionTokens(content, rel) ?? [];
	return sortUnits([...functionUnits(rel, lines, entries), ...testUnits(rel, content, lines)]);
}

function walkMarkdown(root: string, dir: string, out: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (DOC_WALK_SKIP.has(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walkMarkdown(root, full, out);
		else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(full);
	}
}

function inScope(rel: string, include: readonly string[], exclude: readonly string[]): boolean {
	const included = include.length === 0 || matchesAnyGlob(rel, [...include]);
	return included && !matchesAnyGlob(rel, [...exclude]);
}

/** Every unit in the repository within the scope globs: code through the
 *  semantic discovery (tests included) plus markdown. */
export function extractRepoUnits(cwd: string, opts: RepoUnitsOptions = {}): Unit[] {
	const include = opts.include ?? DEFAULT_SCOPE.include;
	const exclude = opts.exclude ?? DEFAULT_SCOPE.exclude;
	const config: SemanticTeamConfig = { ...(opts.config ?? defaultSemanticTeamConfig()), include: [...include], exclude: [...exclude] };
	const units: Unit[] = [];
	for (const source of discoverSemanticSources(cwd, config, true)) {
		units.push(...extractUnits(source.relativePath, source.content));
	}
	if (opts.includeDocs !== false) {
		const docs: string[] = [];
		walkMarkdown(cwd, cwd, docs);
		for (const doc of docs) {
			const rel = slashPath(relative(cwd, doc));
			if (inScope(rel, include, exclude)) units.push(...extractUnits(rel, readFileSync(doc, "utf8")));
		}
	}
	return sortUnits(units);
}
