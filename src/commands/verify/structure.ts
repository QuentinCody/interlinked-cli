import { errorMessage } from "../../lib/error-message.js";
// ===========================================
// Structure verification helpers
// ===========================================
// Builds the artifact graph, runs structure rules, and formats output for
// both JSON and human-readable modes. Exit-code side effects (0/1/2/3) live
// here; `verify.ts` just calls in and the process exit code is set.

import { calculateAdoption } from "../../harness/structure/adoption.js";
import { ArtifactGraph } from "../../harness/structure/artifact-graph.js";
import { isBaselined } from "../../harness/structure/baseline.js";
import {
	computeManifestHash,
	isCacheStale,
	readBaseline,
} from "../../harness/structure/cache-manager.js";
import { runAllExtractors } from "../../harness/structure/extractors/index.js";
import { evaluateStructureRules } from "../../harness/structure/rules/index.js";
import { layerDeclaredArtifacts } from "../../harness/structure/structure-checks.js";
import { formatStructureVerifyOutput } from "../../harness/structure/structure-formatter.js";
import {
	getImplicitConfig,
	loadStructureConfig,
} from "../../harness/structure/structure-loader.js";
import type { JsonObject } from "../../lib/json-types.js";
import type { StructureConfig, StructureVerifyOutput } from "../../harness/structure/types.js";

const EXIT_INVALID_STRUCTURE_CONFIG = 2;
const EXIT_DETERMINISTIC_FAILURE = 1;
const EXIT_STRUCTURE_ERROR = 3;

/** Build the structure verification data (shared between JSON and streaming modes). */
function buildStructureData(cwd: string): ReturnType<typeof buildStructureDataImpl> {
	return buildStructureDataImpl(cwd);
}

function buildStructureDataImpl(cwd: string) {
	// Synchronous imports — these are lazily loaded the first time
	const { config, errors: loadErrors, implicit } = loadStructureConfig(cwd);
	const invalidFiles = !implicit && loadErrors.length > 0 ? [...loadErrors] : [];

	// Build graph with extractors + declared artifacts
	const graph = new ArtifactGraph();
	const extracted = runAllExtractors(cwd);
	for (const node of extracted.nodes) graph.addNode(node);
	for (const edge of extracted.edges) graph.addEdge(edge);

	const resolvedConfig = config ?? getImplicitConfig();
	layerDeclaredArtifacts(graph, cwd, resolvedConfig);

	// Get all source file paths from the graph for repo-wide rule evaluation
	const allFiles = [
		...new Set(
			graph
				.toNodesJson()
				.nodes.map((n) => n.file)
				.filter(Boolean),
		),
	];
	const allFindings = evaluateStructureRules(graph, resolvedConfig, allFiles);
	const baseline = readBaseline(cwd);
	const findings = allFindings.filter((f) => !isBaselined(f, baseline));

	const adoption = calculateAdoption(graph, resolvedConfig);
	const output = formatStructureVerifyOutput({
		config: resolvedConfig,
		findings,
		invalidFiles,
		adoption,
		catalogFresh: !isCacheStale(cwd, computeManifestHash(cwd)),
	});

	return { resolvedConfig, findings, adoption, output, invalidFiles, implicit, loadErrors };
}

/**
 * Public API — consumed by `verify.ts` (JSON mode).
 *
 * Build structure JSON section for outputJson (synchronous). Also sets exit
 * codes for structure invalid-config and deterministic-failure scenarios.
 */
export function buildStructureJsonSection(
	cwd: string,
	opts: { adoptionGate?: boolean },
): JsonObject {
	try {
		const { resolvedConfig, findings, adoption, output, implicit, loadErrors } =
			buildStructureData(cwd);

		// Exit code 2: invalid structure configuration (highest priority)
		if (loadErrors.length > 0 && !implicit && resolvedConfig.verify.fail_on_invalid_structure) {
			process.exitCode = EXIT_INVALID_STRUCTURE_CONFIG;
			return { ...output };
		}

		// Exit code 1: deterministic structure failures or adoption gate
		const deterministicFailures = findings.filter((f) => f.determinism === FULLY_DETERMINISTIC);
		if (deterministicFailures.length > 0 && resolvedConfig.verify.fail_on_deterministic) {
			process.exitCode = EXIT_DETERMINISTIC_FAILURE;
		}

		if (opts.adoptionGate) {
			const thresholds = resolvedConfig.adoption.coverage_thresholds;
			for (const [cat, threshold] of Object.entries(thresholds)) {
				if ((adoption[cat] ?? 0) < threshold) {
					process.exitCode = EXIT_DETERMINISTIC_FAILURE;
				}
			}
		}

		return { ...output };
	} catch {
		process.exitCode = EXIT_STRUCTURE_ERROR;
		return { error: "Structure verification failed" };
	}
}

const ADOPTION_STRONG = 0.8;
const ADOPTION_ACCEPTABLE = 0.5;
const FULLY_DETERMINISTIC = "fully_deterministic";

/**
 * Render the human-readable (non-JSON) structure verification report to
 * stderr: header, mode, finding counts, per-finding details (with their
 * required-update pointers), and the adoption summary.
 */
function writeStructureTextReport(output: StructureVerifyOutput): void {
	process.stderr.write("\n  \x1b[1minterlinked verify --structure\x1b[0m\n");
	process.stderr.write(`  mode: ${output.mode}\n`);
	process.stderr.write(
		`  findings: ${output.findings.fully_deterministic} deterministic, ${output.findings.partially_deterministic} partial, ${output.findings.heuristic} heuristic\n`,
	);
	if (output.details.length > 0) {
		process.stderr.write("\n");
		for (const d of output.details) {
			process.stderr.write(`  \x1b[33m${d.name}\x1b[0m ${d.file}\n`);
			process.stderr.write(`    artifact: ${d.artifact_id} (${d.determinism})\n`);
			for (const u of d.required_updates) {
				process.stderr.write(`    → ${u.file} (${u.kind})\n`);
			}
		}
	}
	process.stderr.write("\n  \x1b[1madoption:\x1b[0m\n");
	for (const [cat, val] of Object.entries(output.adoption)) {
		const pct = (val * 100).toFixed(0);
		let color = "\x1b[31m";
		if (val >= ADOPTION_STRONG) color = "\x1b[32m";
		else if (val >= ADOPTION_ACCEPTABLE) color = "\x1b[33m";
		process.stderr.write(`    ${cat}: ${color}${pct}%\x1b[0m\n`);
	}
	process.stderr.write("\n");
}

/**
 * Enforce `--adoption-gate`: compare each category's adoption against its
 * configured threshold, writing a failure line (text mode only) and setting
 * the deterministic-failure exit code for every category that misses. Guard
 * clause makes this a no-op when the gate wasn't requested.
 */
function applyAdoptionGate(
	opts: { json?: boolean; adoptionGate?: boolean },
	resolvedConfig: StructureConfig,
	adoption: Record<string, number>,
): void {
	if (!opts.adoptionGate) return;
	const thresholds = resolvedConfig.adoption.coverage_thresholds;
	for (const [cat, threshold] of Object.entries(thresholds)) {
		const actual = adoption[cat] ?? 0;
		if (actual < threshold) {
			if (!opts.json) {
				process.stderr.write(
					`  \x1b[31madoption gate failed:\x1b[0m ${cat} at ${(actual * 100).toFixed(0)}% (threshold: ${(threshold * 100).toFixed(0)}%)\n`,
				);
			}
			process.exitCode = EXIT_DETERMINISTIC_FAILURE;
		}
	}
}

/**
 * Public API — consumed by `verify.ts` (streaming / --structure-only mode).
 *
 * Run the structure verification and write either a JSON object or a
 * human-readable report. Exits with codes 1, 2, or 3 on failure.
 */
export async function runStructureVerify(
	cwd: string,
	opts: { json?: boolean; adoptionGate?: boolean; structure?: boolean; structureOnly?: boolean },
): Promise<void> {
	try {
		const data = buildStructureData(cwd);
		const { resolvedConfig, findings, adoption, output, invalidFiles, implicit, loadErrors } =
			data;

		// Exit code 2: invalid structure configuration
		if (loadErrors.length > 0 && !implicit && resolvedConfig.verify.fail_on_invalid_structure) {
			if (opts.json) {
				process.stdout.write(
					`${JSON.stringify({ structure: { mode: resolvedConfig.mode, invalid_files: invalidFiles, error: "Invalid structure configuration" } }, null, 2)}\n`,
				);
			} else {
				process.stderr.write("\n  \x1b[31mInvalid structure configuration:\x1b[0m\n");
				for (const e of loadErrors) process.stderr.write(`    ${e}\n`);
				process.stderr.write("\n");
			}
			process.exitCode = EXIT_INVALID_STRUCTURE_CONFIG;
			return;
		}

		if (opts.json) {
			process.stdout.write(`${JSON.stringify({ structure: output }, null, 2)}\n`);
		} else {
			writeStructureTextReport(output);
		}

		// Exit code logic per spec
		const deterministicFailures = findings.filter((f) => f.determinism === FULLY_DETERMINISTIC);
		if (deterministicFailures.length > 0 && resolvedConfig.verify.fail_on_deterministic) {
			process.exitCode = EXIT_DETERMINISTIC_FAILURE;
		}

		// --adoption-gate
		applyAdoptionGate(opts, resolvedConfig, adoption);
	} catch (e) {
		process.stderr.write(
			`  \x1b[31mStructure verification failed:\x1b[0m ${errorMessage(e)}\n`,
		);
		process.exitCode = EXIT_STRUCTURE_ERROR;
	}
}
