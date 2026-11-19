import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inventoryPaths } from "./inventory-paths.js";
import { VENDOR_PATH } from "./inventory-roles.js";
import { classifyByPath, type RoleDecision } from "./role-evidence.js";
import { type AttributeRule, attributeVerdict, readAttributeRules, sortAttributeRules } from "./role-generator-attributes.js";
import { buildClaimIndex, type ClaimIndex, type ClaimReading, type ClaimSkip, type RawClaim, type ResolvedClaim, resolveClaims } from "./role-generator-claims.js";
import { isCommandSourceName, readGeneratorCommands } from "./role-generator-command.js";
import { isGeneratorConfigName, readGeneratorConfig } from "./role-generator-config.js";
import { isDocName, readDocStatements } from "./role-generator-docs.js";
import { findUniformDirectories, type UniformDirectory } from "./role-generator-uniform.js";
import { applyToolExclude, loadToolExcludes, type ToolExcludes } from "./role-tool-excludes.js";

/**
 * Repository-level evidence for source roles, read from files and never executed. One load per repository gives, for each tracked product
 * path, the strongest evidence that holds:
 *   1. `attributes`: `.gitattributes` linguist-generated / linguist-vendored.
 *   2. `generator-config`: a generator's own config or manifest names the output (buf, sqlc, prisma, orval, openapi-ts, graphql-codegen,
 *      oapi-codegen, `.openapi-generator/FILES`). `generator-command`: a repository script runs a generator with an output path, or checks
 *      that a path is fresh after regeneration. These two set the file aside as `generated` ALONE: the owner declared a generator.
 *   3. `uniform-structure`: a directory of near-identical files. Alone it is only a candidate (the role stays `product`, the decision carries
 *      `candidate`); with a second kind (a linter exclude of the files, or a document that names a generator and the directory) it is `generated`.
 *   4. `tool-config`: a linter exclude alone gives the role `unlinted` ("not linted by the owner"), never `generated`.
 * Only a `product` file with no earlier evidence moves. Unsupported dialects and unusable paths are counted, not guessed.
 */
export interface RepoEvidenceSummary {
	files: { attributes: number; generatorConfigs: number; commandSources: number; docs: number };
	attributeRules: number;
	claims: { config: number; command: number };
	uniform: Array<{ dir: string; files: number; detail: string }>;
	skipped: Record<string, number>;
	skippedList: ClaimSkip[];
}

export interface RepoEvidence {
	tools: ToolExcludes;
	attributes: readonly AttributeRule[];
	claims: ClaimIndex;
	uniform: readonly UniformDirectory[];
	docs: readonly ResolvedClaim[];
	summary(): RepoEvidenceSummary;
}

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_DOC_FILES = 3000;
const SKIPPED_LISTED = 50;

function readText(root: string, file: string): string | null {
	try {
		const absolute = join(root, file);
		return statSync(absolute).size > MAX_TEXT_BYTES ? null : readFileSync(absolute, "utf8");
	} catch { return null; }
}

interface Gathered { attributes: AttributeRule[]; raw: RawClaim[]; skipped: ClaimSkip[]; counts: RepoEvidenceSummary["files"]; }

const isAttributesFile = (file: string): boolean => file === ".gitattributes" || file.endsWith("/.gitattributes");

/** Add what one evidence file says; the counts say how many files of each kind were read. */
function absorb(into: Gathered, file: string, text: string): void {
	if (isAttributesFile(file)) {
		const reading = readAttributeRules(file, text);
		into.attributes.push(...reading.rules); into.skipped.push(...reading.skipped); into.counts.attributes++;
	}
	const readings: ClaimReading[] = [];
	if (isGeneratorConfigName(file)) { readings.push(readGeneratorConfig(file, text)); into.counts.generatorConfigs++; }
	if (isCommandSourceName(file)) { readings.push(readGeneratorCommands(file, text)); into.counts.commandSources++; }
	for (const reading of readings) { into.raw.push(...reading.claims); into.skipped.push(...reading.skipped); }
}

function gather(root: string, tracked: readonly string[]): Gathered {
	const gathered: Gathered = { attributes: [], raw: [], skipped: [], counts: { attributes: 0, generatorConfigs: 0, commandSources: 0, docs: 0 } };
	for (const file of tracked) {
		if (VENDOR_PATH.test(file) || !(isAttributesFile(file) || isGeneratorConfigName(file) || isCommandSourceName(file))) continue;
		const text = readText(root, file);
		if (text !== null) absorb(gathered, file, text);
	}
	return gathered;
}

function readDocs(root: string, tracked: readonly string[]): ResolvedClaim[] {
	const claims: ResolvedClaim[] = [];
	for (const file of tracked.filter((path) => isDocName(path) && !VENDOR_PATH.test(path)).slice(0, MAX_DOC_FILES)) {
		const text = readText(root, file);
		if (text !== null) claims.push(...readDocStatements(file, text, tracked));
	}
	return claims;
}

const countSkips = (skips: readonly ClaimSkip[]): Record<string, number> => {
	const counts: Record<string, number> = {};
	for (const skip of skips) counts[`${skip.tool}:${skip.reason}`] = (counts[`${skip.tool}:${skip.reason}`] ?? 0) + 1;
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
};

/** Build the evidence of a repository from its tracked paths (or, outside git, the walked files). */
function buildRepoEvidence(root: string, tracked: readonly string[], tools: ToolExcludes): RepoEvidence {
	const gathered = gather(root, tracked), rules = sortAttributeRules(gathered.attributes);
	const resolved = resolveClaims(gathered.raw, tracked), claims = buildClaimIndex(resolved.claims);
	const settled = (path: string): boolean => attributeVerdict(rules, path) !== null || claims.match(path) !== null;
	const candidates = tracked.filter((path) => classifyByPath(path).role === "product" && !settled(path));
	const uniform = findUniformDirectories(candidates, (path) => readText(root, path));
	const docs = uniform.length === 0 ? [] : readDocs(root, tracked);
	const skipped = [...gathered.skipped, ...resolved.skipped];
	return { tools, attributes: rules, claims, uniform, docs,
		summary: () => ({ files: { ...gathered.counts, docs: docs.length }, attributeRules: rules.length,
			claims: { config: resolved.claims.filter((c) => c.kind === "generator-config").length, command: resolved.claims.filter((c) => c.kind === "generator-command").length },
			uniform: uniform.map((u) => ({ dir: u.dir, files: u.files, detail: u.detail })), skipped: countSkips(skipped), skippedList: skipped.slice(0, SKIPPED_LISTED) }) };
}

const cache = new Map<string, RepoEvidence>();
export function clearRepoEvidenceCache(): void { cache.clear(); }

export function loadRepoEvidence(root: string, paths?: readonly string[]): RepoEvidence {
	const cached = paths === undefined ? cache.get(root) : undefined;
	if (cached !== undefined) return cached;
	const tracked = (paths ?? inventoryPaths(root).paths).map((path) => path.replaceAll("\\", "/"));
	const evidence = buildRepoEvidence(root, tracked, loadToolExcludes(root, tracked));
	if (paths === undefined) cache.set(root, evidence);
	return evidence;
}

const covers = (target: string, dir: string): boolean => dir === target || dir.startsWith(`${target}/`) || target.startsWith(`${dir}/`);

function declared(path: string, evidence: RepoEvidence): RoleDecision | null {
	const attribute = attributeVerdict(evidence.attributes, path);
	if (attribute !== null) {
		const { rule } = attribute;
		return { role: attribute.role, from: "product", evidence: { kind: "attributes", detail: `linguist-${rule.kind} \`${rule.pattern}\` (${rule.file}:${rule.line})` } };
	}
	const claim = evidence.claims.match(path);
	if (claim === null) return null;
	return { role: "generated", from: "product", evidence: { kind: claim.kind === "generator-command" ? "generator-command" : "generator-config", detail: `${claim.tool} writes \`${claim.target}\` (${claim.file}:${claim.line})` } };
}

function uniformDecision(path: string, evidence: RepoEvidence, linted: RoleDecision): RoleDecision | null {
	const directory = evidence.uniform.find((u) => path.startsWith(`${u.root}/`) || path.startsWith(`${u.dir}/`));
	if (directory === undefined) return null;
	const confirmation = linted.evidence !== null ? `linter exclude, ${linted.evidence.detail}`
		: ((doc) => (doc === undefined ? null : `${doc.file}:${doc.line} names ${doc.tool} and \`${doc.target}\``))(evidence.docs.find((d) => covers(d.target, directory.dir)));
	if (confirmation === null) return { role: "product", evidence: null, from: null, candidate: { dir: directory.dir, detail: directory.detail } };
	return { role: "generated", from: "product", evidence: { kind: "uniform-structure", detail: `${directory.detail}; confirmed by ${confirmation}` } };
}

/** The decision for `path` after repository evidence. Only a `product` path with no earlier evidence moves. */
export function applyRepoEvidence(evidence: RepoEvidence, path: string, decision: RoleDecision): RoleDecision {
	if (decision.role !== "product" || decision.evidence !== null) return decision;
	const normalized = path.replaceAll("\\", "/");
	const stated = declared(normalized, evidence);
	if (stated !== null) return stated;
	const linted = applyToolExclude(evidence.tools, normalized, decision);
	return uniformDecision(normalized, evidence, linted) ?? linted;
}
