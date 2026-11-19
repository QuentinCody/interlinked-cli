import { posix } from "node:path";
import type { ClaimReading, ClaimSkip, RawClaim } from "./role-generator-claims.js";
import { lineAt, matchBracket, maskComments } from "./role-tool-config-text.js";

/**
 * Generator configuration that names the path the generator writes, read as text (never imported or run). Every dialect here is one
 * where the OUTPUT is a field of the file: buf, sqlc, prisma, orval, @hey-api/openapi-ts, graphql-codegen, oapi-codegen and the
 * `.openapi-generator/FILES` manifest. A config that exists but names no output (openapi-python-client, drizzle, speakeasy, fern,
 * relay, kubb) is counted as skipped, not guessed. A file with a generic name (`codegen.ts`) that has no `generates` map names nothing.
 * Output paths are relative to the config's directory (the resolver also tries the repository root).
 */
const NO_OUTPUT_DIALECTS: ReadonlyArray<{ pattern: RegExp; tool: string; reason: string }> = [
	{ pattern: /(?:^|\/)[\w.-]*python-client[\w.-]*\.ya?ml$/, tool: "openapi-python-client", reason: "no-output-path" },
	{ pattern: /(?:^|\/)drizzle\.config\.[cm]?[jt]s$/, tool: "drizzle-kit", reason: "unsupported-dialect" },
	{ pattern: /(?:^|\/)\.speakeasy\/gen\.ya?ml$/, tool: "speakeasy", reason: "unsupported-dialect" },
	{ pattern: /(?:^|\/)\.stats\.yml$/, tool: "stainless", reason: "unsupported-dialect" },
	{ pattern: /(?:^|\/)relay\.config\.[cm]?[jt]s$/, tool: "relay", reason: "unsupported-dialect" },
	{ pattern: /(?:^|\/)kubb\.config\.[cm]?[jt]s$/, tool: "kubb", reason: "unsupported-dialect" },
];

const READERS: ReadonlyArray<{ pattern: RegExp; read: (file: string, text: string) => ClaimReading }> = [
	{ pattern: /(?:^|\/)buf\.gen\.ya?ml$/, read: (file, text) => yamlOut(file, text, "buf") },
	{ pattern: /(?:^|\/)sqlc\.(?:ya?ml|json)$/, read: sqlc },
	{ pattern: /(?:^|\/)schema\.prisma$/, read: prisma },
	{ pattern: /(?:^|\/)orval\.config\.[cm]?[jt]s$/, read: orval },
	{ pattern: /(?:^|\/)openapi-ts\.config\.[cm]?[jt]s$/, read: openApiTs },
	{ pattern: /(?:^|\/)codegen\.(?:ya?ml|[cm]?[jt]s)$/, read: graphqlCodegen },
	{ pattern: /(?:^|\/)\.?oapi-codegen\.ya?ml$/, read: (file, text) => yamlOut(file, text, "oapi-codegen", "output") },
	{ pattern: /(?:^|\/)\.openapi-generator\/FILES$/, read: openApiGeneratorFiles },
	{ pattern: /(?:^|\/)(?:config|[\w.-]*openapi-generator[\w.-]*)\.ya?ml$/, read: openApiGeneratorFilesMap },
];

export function isGeneratorConfigName(file: string): boolean {
	return READERS.some((reader) => reader.pattern.test(file)) || NO_OUTPUT_DIALECTS.some((dialect) => dialect.pattern.test(file));
}

export function readGeneratorConfig(file: string, text: string): ClaimReading {
	const reader = READERS.find((candidate) => candidate.pattern.test(file));
	if (reader !== undefined) return reader.read(file, text);
	const dialect = NO_OUTPUT_DIALECTS.find((candidate) => candidate.pattern.test(file));
	return dialect === undefined ? { claims: [], skipped: [] } : { claims: [], skipped: [{ file, line: 1, tool: dialect.tool, reason: dialect.reason }] };
}

const baseOf = (file: string): string => (posix.dirname(file) === "." ? "" : posix.dirname(file));

/** Add one raw path as a claim, or as a skip when it holds a variable or template. */
function add(into: ClaimReading, file: string, tool: string, path: string, line: number): void {
	if (/\$\{|\benv\(|process\.env/.test(path)) { into.skipped.push({ file, line, tool, reason: "variable-path", pattern: path }); return; }
	into.claims.push({ tool, path, baseDir: baseOf(file), file, line, kind: "generator-config" });
}

const unquote = (value: string): string => value.trim().replace(/\s+#.*$/, "").replace(/^['"]|['"]$/g, "");

function yamlOut(file: string, text: string, tool: string, key = "out"): ClaimReading {
	const reading: ClaimReading = { claims: [], skipped: [] }, pattern = new RegExp(`^\\s*-?\\s*${key}\\s*:\\s*(\\S.*)$`);
	for (const [index, raw] of text.split("\n").entries()) {
		if (raw.trim().startsWith("#")) continue;
		const found = pattern.exec(raw);
		if (found?.[1] !== undefined && unquote(found[1]) !== "") add(reading, file, tool, unquote(found[1]), index + 1);
	}
	return reading;
}

/** The file extensions that a sqlc `gen` language writes; a language not listed claims every extension. */
const SQLC_EXTENSIONS: Readonly<Record<string, readonly string[]>> = { go: [".go"], kotlin: [".kt"], python: [".py"], typescript: [".ts"], java: [".java"], csharp: [".cs"], ruby: [".rb"] };

/** Mark every claim of a reading with the inputs that the same config names (a claim on an output directory never covers them) and the output extensions. */
function withInputs(reading: ClaimReading, inputs: readonly string[], extensions: readonly string[] = []): ClaimReading {
	const literal = inputs.filter((input) => input !== "" && !/[*?{}\[\]]/.test(input));
	return { ...reading, claims: reading.claims.map((claim) => ({ ...claim, inputs: [...(claim.inputs ?? []), ...literal], extensions: [...(claim.extensions ?? []), ...extensions] })) };
}

/** The strings of a yaml value: inline (`a`, `"a"`, `[a, b]`) or the `- x` lines that follow the key. */
function yamlValues(lines: readonly string[], at: number, indent: number): string[] {
	const inline = /^\s*(?:-\s+)?[\w-]+\s*:\s*(\S.*)$/.exec(lines[at] ?? "")?.[1];
	if (inline !== undefined) return inline.replace(/^\[|\]$/g, "").split(",").map(unquote).filter((value) => value !== "");
	const values: string[] = [];
	for (let next = at + 1; next < lines.length; next++) {
		const found = /^(\s*)-\s+(\S.*)$/.exec(lines[next] ?? "");
		if (found === null || (found[1] ?? "").length < indent) break;
		values.push(unquote(found[2] ?? ""));
	}
	return values;
}

/** sqlc v2 yaml: per `sql:` item, `schema`/`queries` are inputs and each `gen.<language>.out` is an output of that language. */
function sqlcYaml(file: string, text: string): ClaimReading {
	const lines = text.split("\n"), { indent, starts } = sqlcItemStarts(lines);
	const claims = starts.flatMap((from, n) => {
		const item = lines.slice(from, starts[n + 1] ?? lines.length);
		return sqlcItemOutputs(file, item, from, sqlcItemInputs(item, indent));
	});
	// A config without `sql:` items (the v1 `packages:` layout) keeps the plain `out:` reading, with no input knowledge.
	return claims.length > 0 ? { claims, skipped: [] } : yamlOut(file, text, "sqlc");
}

/** The line indexes where the items of the top-level `sql:` list begin, and their indentation. */
function sqlcItemStarts(lines: readonly string[]): { indent: number; starts: number[] } {
	const start = lines.findIndex((line) => /^sql\s*:\s*$/.test(line));
	if (start === -1) return { indent: 0, starts: [] };
	const width = (line: string): number => line.length - line.trimStart().length;
	const bullets = lines.map((line, index) => ({ line, index })).filter((row) => row.index > start && /^\s*-\s/.test(row.line));
	const indent = bullets[0] === undefined ? 0 : width(bullets[0].line);
	return { indent, starts: bullets.filter((row) => width(row.line) === indent).map((row) => row.index) };
}

/** The `schema` and `queries` values of one `sql:` item. */
function sqlcItemInputs(item: readonly string[], indent: number): string[] {
	return item.flatMap((line, at) => (/^\s*(?:-\s+)?(?:schema|queries)\s*:/.test(line) ? yamlValues(item, at, indent + 1) : []));
}

/** One claim per `gen.<language>.out` of an item, carrying the item's inputs and the language's extensions. `offset` is the item's first line index. */
function sqlcItemOutputs(file: string, item: readonly string[], offset: number, inputs: readonly string[]): RawClaim[] {
	const claims: RawClaim[] = [];
	for (const [at, line] of item.entries()) {
		const out = /^(\s+)out\s*:\s*(\S.*)$/.exec(line);
		if (out?.[2] === undefined) continue;
		const width = (out[1] ?? "").length;
		const language = item.slice(0, at).reverse().find((candidate) => /^\s*\w+\s*:\s*$/.test(candidate) && candidate.length - candidate.trimStart().length < width)?.trim().replace(/:$/, "").trim();
		const one: ClaimReading = { claims: [], skipped: [] };
		add(one, file, "sqlc", unquote(out[2]), offset + at + 1);
		claims.push(...withInputs(one, inputs, SQLC_EXTENSIONS[language ?? ""] ?? []).claims);
	}
	return claims;
}

interface SqlcJsonOutput { out: string; language: string; inputs: string[]; }

/** Every `sql[].gen.<language>.out` of a sqlc json config, in document order, with the item's schema and queries. */
function sqlcJsonOutputs(text: string): SqlcJsonOutput[] {
	let parsed: { sql?: Array<{ schema?: string | string[]; queries?: string | string[]; gen?: Record<string, { out?: string }> }> };
	try { parsed = JSON.parse(text) as typeof parsed; } catch { return []; }
	return (parsed.sql ?? []).flatMap((item) => Object.entries(item.gen ?? {}).flatMap(([language, gen]) => (typeof gen.out === "string" ? [{ out: gen.out, language, inputs: [item.schema ?? [], item.queries ?? []].flat() }] : [])));
}

function sqlcJson(file: string, text: string): ClaimReading {
	const reading: ClaimReading = { claims: [], skipped: [] };
	let cursor = 0;
	for (const output of sqlcJsonOutputs(text)) {
		const at = text.indexOf('"out"', cursor);
		cursor = at === -1 ? cursor : at + 5;
		const one: ClaimReading = { claims: [], skipped: [] };
		add(one, file, "sqlc", output.out, lineAt(text, Math.max(0, at)));
		reading.claims.push(...withInputs(one, output.inputs, SQLC_EXTENSIONS[output.language] ?? []).claims);
	}
	if (reading.claims.length > 0) return reading;
	// A json config without `sql[].gen` (the v1 `packages` layout): every `"out"`, with no input knowledge.
	for (const found of text.matchAll(/"out"\s*:\s*"([^"]+)"/g)) add(reading, file, "sqlc", found[1] ?? "", lineAt(text, found.index ?? 0));
	return reading;
}

function sqlc(file: string, text: string): ClaimReading {
	return file.endsWith(".json") ? sqlcJson(file, text) : sqlcYaml(file, text);
}

function prisma(file: string, text: string): ClaimReading {
	const reading: ClaimReading = { claims: [], skipped: [] }, masked = maskComments(text, "js");
	for (const block of masked.matchAll(/\bgenerator\s+\w+\s*\{/g)) {
		const open = (block.index ?? 0) + block[0].length - 1, close = matchBracket(masked, open);
		const body = masked.slice(open, close === -1 ? masked.length : close);
		const found = /\boutput\s*=\s*(?:"([^"]*)"|(\S+\([^)]*\)))/.exec(body);
		if (found === null) continue;
		add(reading, file, "prisma", found[1] ?? found[2] ?? "", lineAt(masked, open + found.index));
	}
	return reading;
}

const STRING = "(?:'([^'\\n]*)'|\"([^\"\\n]*)\"|`([^`\\n]*)`)";
const stringValue = (found: RegExpMatchArray, from: number): string => found[from] ?? found[from + 1] ?? found[from + 2] ?? "";

function orval(file: string, text: string): ClaimReading {
	const reading: ClaimReading = { claims: [], skipped: [] }, masked = maskComments(text, "js");
	for (const found of masked.matchAll(new RegExp(`\\b(?:target|schemas)\\s*:\\s*${STRING}`, "g"))) add(reading, file, "orval", stringValue(found, 1), lineAt(masked, found.index ?? 0));
	const nested = [...masked.matchAll(new RegExp(`\\binput\\s*:\\s*\\{[^{}]*?\\btarget\\s*:\\s*${STRING}`, "g"))].map((found) => stringValue(found, 1));
	return withInputs(reading, [...scriptInputs(masked, ["input"]), ...nested]);
}

/** The strings assigned to the given keys of a JS/TS config (`input: './spec.json'`): inputs, never outputs. */
function scriptInputs(masked: string, keys: readonly string[]): string[] {
	return [...masked.matchAll(new RegExp(`\\b(?:${keys.join("|")})\\s*:\\s*${STRING}`, "g"))].map((found) => stringValue(found, 1));
}

function openApiTs(file: string, text: string): ClaimReading {
	const reading: ClaimReading = { claims: [], skipped: [] }, masked = maskComments(text, "js");
	const direct = new RegExp(`\\boutput\\s*:\\s*${STRING}`, "g"), nested = new RegExp(`\\boutput\\s*:\\s*\\{[^{}]*?\\bpath\\s*:\\s*${STRING}`, "g");
	for (const found of masked.matchAll(direct)) add(reading, file, "openapi-ts", stringValue(found, 1), lineAt(masked, found.index ?? 0));
	for (const found of masked.matchAll(nested)) add(reading, file, "openapi-ts", stringValue(found, 1), lineAt(masked, (found.index ?? 0) + found[0].lastIndexOf("path")));
	return withInputs(reading, scriptInputs(masked, ["input"]));
}

/** The map keys under `generates` in a graphql-codegen config, in yaml (indentation) or a JS/TS object. */
function graphqlCodegen(file: string, text: string): ClaimReading {
	if (!/\.ya?ml$/.test(file)) return withInputs(codegenScript(file, text), scriptInputs(maskComments(text, "js"), ["schema", "documents"]));
	const lines = text.split("\n");
	const inputs = lines.flatMap((line, at) => (/^(?:schema|documents)\s*:/.test(line) ? yamlValues(lines, at, 1) : []));
	return withInputs(codegenYaml(file, text), inputs);
}

function codegenYaml(file: string, text: string): ClaimReading {
	const reading: ClaimReading = { claims: [], skipped: [] }, lines = text.split("\n");
	const start = lines.findIndex((line) => /^generates\s*:\s*$/.test(line));
	if (start === -1) return reading;
	let indent = -1;
	for (let at = start + 1; at < lines.length; at++) {
		const line = lines[at] ?? "", width = line.length - line.trimStart().length;
		if (line.trim() === "" || line.trim().startsWith("#")) continue;
		if (width === 0) break;
		indent = indent === -1 ? width : indent;
		const key = width === indent ? /^\s*(?:['"]([^'"]+)['"]|([^\s:'"#][^\s:#]*))\s*:\s*(?:#.*)?$/.exec(line) : null;
		if (key !== null) add(reading, file, "graphql-codegen", key[1] ?? key[2] ?? "", at + 1);
	}
	return reading;
}

function codegenScript(file: string, text: string): ClaimReading {
	const reading: ClaimReading = { claims: [], skipped: [] }, masked = maskComments(text, "js");
	const open = /\bgenerates\s*:\s*\{/.exec(masked);
	if (open === null) return reading;
	const start = open.index + open[0].length - 1, end = matchBracket(masked, start);
	const region = masked.slice(start + 1, end === -1 ? masked.length : end);
	for (const found of region.matchAll(new RegExp(`${STRING}\\s*:\\s*[\\[{]`, "g"))) {
		const key = stringValue(found, 1);
		if (/[./]/.test(key)) add(reading, file, "graphql-codegen", key, lineAt(masked, start + 1 + (found.index ?? 0)));
	}
	return reading;
}

/**
 * An openapi-generator config with a `files:` map: every `destinationFilename` is a file that the generator writes, relative to `outputDir`
 * (default: the config's directory), which is itself relative to the config's directory. A config.yaml without that key names nothing.
 */
function openApiGeneratorFilesMap(file: string, text: string): ClaimReading {
	const reading: ClaimReading = { claims: [], skipped: [] };
	if (!/^\s+destinationFilename\s*:/m.test(text)) return reading;
	const outputDir = /^outputDir\s*:\s*(\S+)/m.exec(text)?.[1]?.replace(/^['"]|['"]$/g, "") ?? ".";
	const joined = posix.normalize(posix.join(baseOf(file) || ".", outputDir)), base = joined === "." ? "" : joined;
	for (const [index, raw] of text.split("\n").entries()) {
		const found = /^\s+destinationFilename\s*:\s*(\S+)/.exec(raw);
		if (found?.[1] !== undefined) reading.claims.push({ tool: "openapi-generator", path: unquote(found[1]), baseDir: base, file, line: index + 1, kind: "generator-config" });
	}
	return reading;
}

function openApiGeneratorFiles(file: string, text: string): ClaimReading {
	const reading: ClaimReading = { claims: [], skipped: [] as ClaimSkip[] };
	const base = posix.dirname(posix.dirname(file)) === "." ? "" : posix.dirname(posix.dirname(file));
	for (const [index, raw] of text.split("\n").entries()) {
		const path = raw.trim();
		if (path === "" || path.endsWith("/")) continue;
		reading.claims.push({ tool: "openapi-generator", path, baseDir: base, file, line: index + 1, kind: "generator-config" } satisfies RawClaim);
	}
	return reading;
}
