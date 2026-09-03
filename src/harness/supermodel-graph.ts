// ===========================================
// Supermodel `.graph.*` shard reader
// ===========================================
// Read-only consumer of Supermodel-emitted graph shards. We never write,
// generate, or modify graph files — Supermodel's daemon owns that lane.
// See `docs/plans/07-supermodel-graph-integration.md` for the integration
// rationale and `docs/integrations/supermodel.md` for the user-facing
// writeup. Format reference: reference-repos/supermodel-cli/internal/
// shards/render.go.

import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve as resolvePath, sep } from "node:path";
import { nonNull } from "../lib/non-null.js";

const MAX_SHARD_SIZE = 1024 * 1024;
const DOMAIN_SEPARATOR = " · ";

export interface SupermodelGraph {
	/** Absolute path of the shard file we read. */
	shardPath: string;
	/** Absolute path of the source the shard describes. */
	sourcePath: string;
	/** Parsed [impact] section, or null if the section is absent or unparseable. */
	impact: ImpactSection | null;
	/** Parsed [calls] section, or null if absent or unparseable. */
	calls: CallsSection | null;
	/** Parsed [deps] section, or null if absent or unparseable. */
	deps: DepsSection | null;
}

interface ImpactSection {
	risk: "HIGH" | "MEDIUM" | "LOW";
	/** May be empty: Supermodel omits this field when the domain set is empty
	 *  (render.go:190). Parser treats absence as []. */
	domains: string[];
	/** File-granularity count: union of importers and files containing callers
	 *  of any function defined in the source. NOT a count of distinct caller
	 *  sites or import statements — see render.go:128-150 for the union
	 *  computation. */
	direct: number;
	/** Count of files transitively reachable through the import/call graph. */
	transitive: number;
	/** Listed files in the `direct` union. May be empty: Supermodel omits this
	 *  field when direct === 0 (render.go:197). Parser treats absence as []. */
	affects: string[];
}

export interface CallsSection {
	/** "FuncName ← CallerName    file:line" */
	callers: Array<{ fn: string; caller: string; file: string; line: number }>;
	/** "FuncName → CalleeName    file:line" */
	callees: Array<{ fn: string; callee: string; file: string; line: number }>;
}

interface DepsSection {
	imports: string[];
	importedBy: string[];
}

/** Insert `.graph` before the extension. Mirrors Supermodel's ShardFilename
 *  (render.go:23). Operates on a string in/out — does not touch the
 *  filesystem. `src/Foo.tsx` → `src/Foo.graph.tsx`; an extension-less path
 *  like `Makefile` → `Makefile.graph`. */
export function shardPathFor(sourcePath: string): string {
	const ext = extname(sourcePath);
	if (!ext) return `${sourcePath}.graph`;
	const stem = sourcePath.slice(0, -ext.length);
	return `${stem}.graph${ext}`;
}

/** Resolve a source path to absolute. Returns null when the path is relative
 *  and no `cwd` was supplied to resolve it against. */
function resolveSourcePath(sourcePath: string, cwd?: string): string | null {
	if (isAbsolute(sourcePath)) return resolvePath(sourcePath);
	if (!cwd) return null;
	return resolvePath(cwd, sourcePath);
}

/** True when `absSource` is `cwd` itself or lives beneath it — the defensive
 *  traversal check applied whenever a `cwd` is provided. */
function isWithinCwd(absSource: string, cwd: string): boolean {
	const absCwd = resolvePath(cwd);
	const cwdPrefix = absCwd.endsWith(sep) ? absCwd : absCwd + sep;
	return absSource === absCwd || absSource.startsWith(cwdPrefix);
}

/** Read + parse a shard file for a source path.
 *
 *  `sourcePath` may be absolute or relative. `cwd` is required when the path
 *  is relative; the function resolves to absolute before deriving the shard
 *  filename and reading.
 *
 *  Returns null on any of:
 *   - missing source path / cwd needed but not provided
 *   - resolved path escapes cwd via traversal (defensive — only enforced
 *     when cwd is provided)
 *   - shard file does not exist or is not a regular file
 *   - shard file is larger than 1 MB (fail-open guard)
 *   - I/O error (permissions, etc.)
 *   - file contents have no recognizable header or sections
 *
 *  Section-level parse failures (e.g. malformed `risk` value, garbled
 *  `direct` field) null only the affected section. Never throws. */
export function loadGraphForFile(sourcePath: string, cwd?: string): SupermodelGraph | null {
	if (!sourcePath || sourcePath.trim() === "") return null;

	const absSource = resolveSourcePath(sourcePath, cwd);
	if (absSource === null) return null;
	if (cwd && !isWithinCwd(absSource, cwd)) return null;

	const absShard = shardPathFor(absSource);

	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(absShard);
	} catch {
		return null;
	}
	if (!stats.isFile()) return null;
	if (stats.size > MAX_SHARD_SIZE) return null;

	let content: string;
	try {
		content = readFileSync(absShard, "utf8");
	} catch {
		return null;
	}

	return parseGraphFile(content, absSource, absShard);
}

/** Where the shard's real content starts, and which comment style armors it.
 *  Skips a leading run of blank lines and the Go `//go:build ignore` /
 *  `package ignore` preamble, then classifies the first substantive line as
 *  `//`- or `#`-commented. Returns null when nothing substantive is found, or
 *  the first substantive line uses neither comment style. */
function findShardBody(rawLines: string[]): { cursor: number; prefix: "//" | "#" } | null {
	let cursor = 0;
	while (cursor < rawLines.length) {
		const t = nonNull(rawLines[cursor]).trim();
		if (t === "" || t === "//go:build ignore" || t === "package ignore") {
			cursor++;
			continue;
		}
		break;
	}
	if (cursor >= rawLines.length) return null;

	const firstLine = nonNull(rawLines[cursor]).trim();
	if (firstLine.startsWith("//")) return { cursor, prefix: "//" };
	if (firstLine.startsWith("#")) return { cursor, prefix: "#" };
	return null;
}

/** Strip the comment armor from each body line, starting at `cursor`. A
 *  non-comment (rogue) line becomes an empty placeholder rather than being
 *  dropped, so section bucketing below still sees one entry per input line. */
function stripCommentPrefix(rawLines: string[], cursor: number, prefix: string): string[] {
	const stripped: string[] = [];
	for (let i = cursor; i < rawLines.length; i++) {
		const t = nonNull(rawLines[i]).trim();
		if (t === "") {
			stripped.push("");
			continue;
		}
		if (t.startsWith(prefix)) {
			stripped.push(t.slice(prefix.length).trim());
		} else {
			stripped.push("");
		}
	}
	return stripped;
}

/** The three shard sections this reader understands. */
type SectionName = "deps" | "calls" | "impact";

/** Classify one uncommented line as a section header. Returns the known
 *  section name, `"unknown"` for any other `[...]` header, or null when the
 *  line is section body text rather than a header. */
function sectionHeaderFor(line: string): SectionName | "unknown" | null {
	if (line === "[deps]") return "deps";
	if (line === "[calls]") return "calls";
	if (line === "[impact]") return "impact";
	if (line.startsWith("[") && line.endsWith("]")) return "unknown";
	return null;
}

interface SectionBuckets {
	sawSection: boolean;
	depsLines: string[];
	callsLines: string[];
	impactLines: string[];
}

/** Group already-uncommented lines by their enclosing `[deps]`/`[calls]`/
 *  `[impact]` header. Unknown section headers (e.g. `[futuristic]`) reset the
 *  current section to null so their body lines are dropped without affecting
 *  known sections. */
function bucketSections(stripped: string[]): SectionBuckets {
	let currentSection: SectionName | null = null;
	let sawSection = false;
	const lines: Record<SectionName, string[]> = { deps: [], calls: [], impact: [] };

	for (const line of stripped) {
		if (line === "") continue;
		const header = sectionHeaderFor(line);
		if (header === "unknown") {
			currentSection = null;
			continue;
		}
		if (header !== null) {
			currentSection = header;
			sawSection = true;
			continue;
		}
		if (currentSection !== null) lines[currentSection].push(line);
	}

	return { sawSection, depsLines: lines.deps, callsLines: lines.calls, impactLines: lines.impact };
}

/** Parse shard text. Exported for tests. Tolerant: unknown lines are ignored,
 *  unknown section names are ignored, malformed fields within a section null
 *  only that section. Returns null only when the input has no recognizable
 *  structure at all (no header, no sections). */
export function parseGraphFile(
	content: string,
	sourcePath: string,
	shardPath: string,
): SupermodelGraph | null {
	if (!content || content.trim() === "") return null;
	const rawLines = content.split(/\r?\n/);

	const body = findShardBody(rawLines);
	if (!body) return null;

	const stripped = stripCommentPrefix(rawLines, body.cursor, body.prefix);
	const { sawSection, depsLines, callsLines, impactLines } = bucketSections(stripped);

	if (!sawSection) {
		return { shardPath, sourcePath, impact: null, calls: null, deps: null };
	}

	return {
		shardPath,
		sourcePath,
		impact: parseImpact(impactLines),
		calls: parseCalls(callsLines),
		deps: parseDeps(depsLines),
	};
}

function parseDeps(lines: string[]): DepsSection | null {
	if (lines.length === 0) return null;
	const imports: string[] = [];
	const importedBy: string[] = [];
	for (const line of lines) {
		const [key, ...valueParts] = line.split(/\s+/);
		const value = valueParts.join(" ");
		if (!value) continue;
		if (key === "imports") imports.push(value);
		else if (key === "imported-by") importedBy.push(value);
	}
	if (imports.length === 0 && importedBy.length === 0) return null;
	return { imports, importedBy };
}

/** Which side of the arrow a `[calls]` line describes. */
type CallDirection = "caller" | "callee";

/** Locate the "FuncName ← Caller" / "FuncName → Callee" arrow in a trimmed
 *  line and report which direction it encodes. Returns null when neither
 *  arrow glyph is present (line is not a recognizable calls entry). */
function detectCallDirection(trimmed: string): { direction: CallDirection; arrowIdx: number } | null {
	const callerIdx = trimmed.indexOf(" ← ");
	if (callerIdx !== -1) return { direction: "caller", arrowIdx: callerIdx };
	const calleeIdx = trimmed.indexOf(" → ");
	if (calleeIdx !== -1) return { direction: "callee", arrowIdx: calleeIdx };
	return null;
}

/** Parse the tokens after the arrow ("CallerName    file:line" or just
 *  "CallerName" or "CallerName    ?") into the other-function name plus an
 *  optional file:line site. Returns null only for the defensive (in practice
 *  unreachable, since `rest` is always a non-empty trimmed string) empty-split
 *  case, mirroring the original inline `continue`. */
function parseCallTarget(rest: string): { other: string; file: string; line: number } | null {
	const restTokens = rest.split(/\s+/);
	if (restTokens.length === 0) return null;
	if (restTokens.length === 1) {
		return { other: nonNull(restTokens[0]), file: "", line: 0 };
	}

	const last = nonNull(restTokens[restTokens.length - 1]);
	const colonIdx = last.lastIndexOf(":");
	if (colonIdx !== -1) {
		const linePart = last.slice(colonIdx + 1);
		const parsed = Number.parseInt(linePart, 10);
		if (Number.isFinite(parsed)) {
			return {
				other: restTokens.slice(0, -1).join(" "),
				file: last.slice(0, colonIdx),
				line: parsed,
			};
		}
		return { other: rest, file: "", line: 0 };
	}
	if (last === "?") {
		return { other: restTokens.slice(0, -1).join(" "), file: "", line: 0 };
	}
	return { other: rest, file: "", line: 0 };
}

/** One parsed `[calls]` edge: the subject function, the direction of the
 *  arrow, and the other end (name plus optional file:line site). */
interface CallEdge {
	direction: CallDirection;
	fn: string;
	other: string;
	file: string;
	line: number;
}

/** Parse one `[calls]` line into a call edge. Returns null when the line is
 *  blank, carries no arrow glyph, or is missing either side of the arrow. */
function parseCallLine(line: string): CallEdge | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	const detected = detectCallDirection(trimmed);
	if (!detected) return null;

	const fn = trimmed.slice(0, detected.arrowIdx).trim();
	const rest = trimmed.slice(detected.arrowIdx + 3).trim();
	if (!fn || !rest) return null;

	const target = parseCallTarget(rest);
	if (!target) return null;

	return { direction: detected.direction, fn, other: target.other, file: target.file, line: target.line };
}

function parseCalls(lines: string[]): CallsSection | null {
	if (lines.length === 0) return null;
	const callers: CallsSection["callers"] = [];
	const callees: CallsSection["callees"] = [];

	for (const line of lines) {
		const edge = parseCallLine(line);
		if (!edge) continue;
		const site = { file: edge.file, line: edge.line };
		if (edge.direction === "caller") callers.push({ fn: edge.fn, caller: edge.other, ...site });
		else callees.push({ fn: edge.fn, callee: edge.other, ...site });
	}

	if (callers.length === 0 && callees.length === 0) return null;
	return { callers, callees };
}

interface ImpactAccumulator {
	risk: ImpactSection["risk"] | null;
	domains: string[];
	direct: number | null;
	transitive: number | null;
	affects: string[];
	valid: boolean;
}

function splitImpactList(value: string): string[] | null {
	if (!value) return null;
	return value
		.split(DOMAIN_SEPARATOR)
		.map((d) => d.trim())
		.filter(Boolean);
}

function parseImpactNumber(value: string): number | null {
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : null;
}

function applyImpactField(acc: ImpactAccumulator, key: string | undefined, value: string): void {
	switch (key) {
		case "risk":
			if (value === "HIGH" || value === "MEDIUM" || value === "LOW") {
				acc.risk = value;
			} else {
				acc.valid = false;
			}
			break;
		case "domains": {
			const parsed = splitImpactList(value);
			if (parsed !== null) acc.domains = parsed;
			break;
		}
		case "direct": {
			const n = parseImpactNumber(value);
			if (n !== null) acc.direct = n;
			else acc.valid = false;
			break;
		}
		case "transitive": {
			const n = parseImpactNumber(value);
			if (n !== null) acc.transitive = n;
			else acc.valid = false;
			break;
		}
		case "affects": {
			const parsed = splitImpactList(value);
			if (parsed !== null) acc.affects = parsed;
			break;
		}
	}
}

function parseImpact(lines: string[]): ImpactSection | null {
	if (lines.length === 0) return null;
	const acc: ImpactAccumulator = {
		risk: null,
		domains: [],
		direct: null,
		transitive: null,
		affects: [],
		valid: true,
	};

	for (const line of lines) {
		const trimmed = line.trim();
		const [key, ...valueParts] = trimmed.split(/\s+/);
		const value = valueParts.join(" ");
		applyImpactField(acc, key, value);
	}

	if (!acc.valid) return null;
	if (!acc.risk || acc.direct === null || acc.transitive === null) return null;
	return { risk: acc.risk, domains: acc.domains, direct: acc.direct, transitive: acc.transitive, affects: acc.affects };
}
