// ===========================================
// Simplification review — advisory opportunity detectors
// ===========================================
// These patterns intentionally emit candidate/heuristic evidence only. They
// identify places worth semantic review; none proves equivalence or deletion
// safety, and none is wired into the harness or any blocking policy.

import { existsSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { findDeadInterfaceFields } from "../harness/checks/dead-interface-fields.js";
import { stripComments } from "../harness/checks/shared-text-utils.js";
import { isJsonObject } from "../lib/json-types.js";
import { cyclomaticForMetrics } from "./metrics.js";
import {
	LOCAL_SIMPLIFICATION_EXTENSIONS,
	type SimplificationCandidateDraft,
	type SimplificationDetectorResult,
} from "./simplify-detectors.js";

const TEST_OR_GENERATED_RE = /(?:^|\/)(?:__tests__|generated|__generated__|fixtures)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const CONFIG_CONTAINER_RE = /(?:Config|Configuration|Flags|Options|Settings)$/;
const COMPLEXITY_OPPORTUNITY_THRESHOLD = 25;
const FUNCTION_WRAPPER_RE = /(?:^|\n)\s*(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^\{]+)?\{\s*(?:return\s+)?(?:await\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\([^{};]*\);?\s*\}/g;
const ONE_PRODUCT_FACTORY_RE = /(?:^|\n)\s*(export\s+)?(?:async\s+)?function\s+((?:create|make|build)[A-Za-z0-9_$]*)\s*\([^)]*\)\s*(?::\s*[^\{]+)?\{\s*return\s+new\s+([A-Za-z_$][\w$]*)\([^{};]*\);?\s*\}/gi;
const IMPORT_SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)["']([^"']+)["']/g;

interface SourceFile {
	absolute: string;
	relative: string;
	content: string;
}

function sourceFiles(cwd: string, files: string[]): SourceFile[] {
	const out: SourceFile[] = [];
	for (const absolute of files) {
		const rel = relative(cwd, absolute).replace(/\\/g, "/");
		if (!LOCAL_SIMPLIFICATION_EXTENSIONS.has(extname(rel).toLowerCase())) continue;
		if (TEST_OR_GENERATED_RE.test(rel)) continue;
		try {
			out.push({ absolute, relative: rel, content: readFileSync(absolute, "utf-8") });
		} catch {
			// Coverage reports the successfully read corpus below.
		}
	}
	return out;
}

function lineAt(content: string, offset: number): number {
	return content.slice(0, offset).split("\n").length;
}

function wrapperDrafts(file: SourceFile): SimplificationCandidateDraft[] {
	const stripped = stripComments(file.content);
	const drafts: SimplificationCandidateDraft[] = [];
	for (const match of stripped.matchAll(FUNCTION_WRAPPER_RE)) {
		if (match[1]) continue; // exported/public boundaries require cloud context
		const name = match[2] ?? "wrapper";
		const target = match[3] ?? "delegate";
		if (target.split(".").at(-1) === name) continue;
		const line = lineAt(stripped, match.index);
		drafts.push({
			source: "opportunity.delegate_only_wrapper",
			remedy: "shrink",
			evidenceState: "candidate",
			confidence: 0.35,
			path: file.relative,
			startLine: line,
			endLine: line + match[0].split("\n").length - 1,
			key: `${name}:${target}`,
			summary: `Private function \`${name}\` only delegates to \`${target}\` in the parsed body.`,
			replacement: "Inline or remove only after checking call-site semantics and the boundary's intent.",
			evidence: [{
				kind: "single-call-function-body",
				state: "candidate",
				detail: "The function body contains only one optional return/await delegate call.",
				path: file.relative,
			}],
			estimatedLoc: null,
			relatedPaths: [],
		});
	}
	return drafts;
}

function factoryDrafts(file: SourceFile): SimplificationCandidateDraft[] {
	const stripped = stripComments(file.content);
	const drafts: SimplificationCandidateDraft[] = [];
	for (const match of stripped.matchAll(ONE_PRODUCT_FACTORY_RE)) {
		if (match[1]) continue;
		const name = match[2] ?? "factory";
		const product = match[3] ?? "product";
		const line = lineAt(stripped, match.index);
		drafts.push({
			source: "opportunity.one_product_factory",
			remedy: "yagni",
			evidenceState: "candidate",
			confidence: 0.3,
			path: file.relative,
			startLine: line,
			endLine: line + match[0].split("\n").length - 1,
			key: `${name}:${product}`,
			summary: `Private factory \`${name}\` has one statically visible product, \`${product}\`.`,
			replacement: `Construct \`${product}\` directly only if no framework, test-seam, or future contract requires the factory.`,
			evidence: [{
				kind: "single-constructor-factory-body",
				state: "candidate",
				detail: "The parsed factory body consists solely of one constructor return.",
				path: file.relative,
			}],
			estimatedLoc: null,
			relatedPaths: [],
		});
	}
	return drafts;
}

function complexityDrafts(file: SourceFile): SimplificationCandidateDraft[] {
	const drafts: SimplificationCandidateDraft[] = [];
	for (const fn of cyclomaticForMetrics(file.content, file.absolute)) {
		if (fn.cyclomatic <= COMPLEXITY_OPPORTUNITY_THRESHOLD) continue;
		drafts.push({
			source: "metrics.cyclomatic_hotspot",
			remedy: "shrink",
			evidenceState: "candidate",
			confidence: 0.2,
			path: file.relative,
			startLine: fn.line,
			endLine: fn.endLine,
			key: `${fn.name}:${fn.cyclomatic}`,
			summary: `\`${fn.name}\` has measured cyclomatic complexity ${fn.cyclomatic}; inspect for a smaller clear implementation.`,
			replacement: null,
			evidence: [{
				kind: "cyclomatic-complexity",
				state: "candidate",
				detail: `Measured ${fn.cyclomatic}; complexity is a hotspot signal, not behavioral equivalence.`,
				path: file.relative,
			}],
			estimatedLoc: null,
			relatedPaths: [],
		});
	}
	return drafts;
}

function configFieldDrafts(cwd: string): SimplificationCandidateDraft[] {
	const sourceRoot = join(cwd, "src");
	if (!existsSync(sourceRoot)) return [];
	return findDeadInterfaceFields(sourceRoot, cwd, {
		containerFilter: (containerName) => CONFIG_CONTAINER_RE.test(containerName),
	})
		.map((finding) => ({
			source: "opportunity.never_read_configuration",
			remedy: "delete" as const,
			evidenceState: "candidate" as const,
			confidence: 0.3,
			path: finding.file,
			startLine: finding.line,
			endLine: finding.line,
			key: `${finding.containerName}.${finding.field}`,
			summary: `Configuration field \`${finding.containerName}.${finding.field}\` has no static read outside its declaration/colocated test.`,
			replacement: null,
			evidence: [{
				kind: "cross-file-field-read-scan" as const,
				state: "candidate" as const,
				detail: "Dynamic property access and external consumers are not visible to this scanner.",
				path: finding.file,
			}],
			estimatedLoc: -1,
			relatedPaths: [],
		}));
}

function importedPackages(files: SourceFile[]): Set<string> {
	const packages = new Set<string>();
	for (const file of files) {
		for (const match of stripComments(file.content).matchAll(IMPORT_SPECIFIER_RE)) {
			const specifier = match[1];
			if (!specifier || specifier.startsWith(".") || specifier.startsWith("node:")) continue;
			const parts = specifier.split("/");
			packages.add(specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier));
		}
	}
	return packages;
}

function packageManifest(cwd: string): { raw: string; dependencies: Map<string, string> } | null {
	try {
		const raw = readFileSync(join(cwd, "package.json"), "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (!isJsonObject(parsed) || !isJsonObject(parsed.dependencies)) return null;
		const dependencies = new Map<string, string>();
		for (const [name, version] of Object.entries(parsed.dependencies)) {
			if (typeof version === "string") dependencies.set(name, version);
		}
		return { raw, dependencies };
	} catch {
		return null;
	}
}

function unusedDependencyDrafts(cwd: string, files: SourceFile[]): SimplificationCandidateDraft[] {
	const manifest = packageManifest(cwd);
	if (!manifest) return [];
	const imported = importedPackages(files);
	const drafts: SimplificationCandidateDraft[] = [];
	for (const [name] of manifest.dependencies) {
		if (imported.has(name)) continue;
		const line = lineAt(manifest.raw, manifest.raw.indexOf(`"${name}"`));
		drafts.push({
			source: "opportunity.unused_runtime_dependency",
			remedy: "delete",
			evidenceState: "candidate",
			confidence: 0.25,
			path: "package.json",
			startLine: line,
			endLine: line,
			key: name,
			summary: `Runtime dependency \`${name}\` has no static import/require in the covered source corpus.`,
			replacement: null,
			evidence: [{
				kind: "manifest-to-static-import-scan",
				state: "candidate",
				detail: "CLI loading, plugins, config files, generated code, and dynamic module names can make this a false positive.",
				path: "package.json",
			}],
			estimatedLoc: -1,
			estimatedDependenciesRemoved: [name],
			relatedPaths: [],
		});
	}
	return drafts;
}

export function collectAdvisoryOpportunityEvidence(
	cwd: string,
	files: string[],
): SimplificationDetectorResult {
	const corpus = sourceFiles(cwd, files);
	const drafts = corpus.flatMap((file) => [
		...wrapperDrafts(file),
		...factoryDrafts(file),
		...complexityDrafts(file),
	]);
	drafts.push(...configFieldDrafts(cwd), ...unusedDependencyDrafts(cwd, corpus));
	return {
		drafts,
		sources: [{
			source: "opportunity.advisory-patterns",
			status: "partial",
			files_considered: corpus.length,
			analyzed_paths: corpus
				.map((file) => file.relative)
				.sort((left, right) => left.localeCompare(right)),
			findings_emitted: drafts.length,
			notes: [
				"Regex/static-graph opportunities are intentionally low-confidence and never block or auto-fix.",
				"Exported wrappers/factories, tests, fixtures, and generated paths are excluded from the local pattern pass.",
			],
		}],
	};
}
