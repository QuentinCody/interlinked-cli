// ===========================================
// Misc Structural Checks
// ===========================================
// Small self-contained structural checks:
//   - checkCoDependencyStaleness: cross-agent staleness warning (Tier 1)
//   - checkJSDocParamMismatch: JSDoc @param vs actual parameters
//   - checkInterfaceChangeImpact: interface body diff → affected importers
//   - checkTestProximity: edited source without an updated test file

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import type { ProjectGraph } from "../project-graph.js";
import type { SessionTracker } from "../session-state.js";
import type { HarnessEvent, StructuralCheckResult } from "../types.js";

/** Sessions (other than the editing agent) that recently read one of the dependents. */
function collectStaleAgentReads(
	dependents: string[],
	sessions: SessionTracker,
	agentName: string,
	stalenessMs: number,
	graph: ProjectGraph,
): Array<{ agent: string; file: string }> {
	const affectedAgents: Array<{ agent: string; file: string }> = [];
	const now = Date.now();

	for (const sess of sessions.getAll()) {
		if (sess.agent_name === agentName) continue;

		for (const dep of dependents) {
			if (!sess.files_read.has(dep)) continue;
			// Check if the read was recent (we track reads but not timestamps,
			// so use the session start as a proxy — if the session is active
			// and has read a dependent, warn)
			const sessionAge = now - new Date(sess.started_at).getTime();
			if (sessionAge < stalenessMs) {
				affectedAgents.push({ agent: sess.agent_name, file: graph.toRelative(dep) });
			}
		}
	}

	return affectedAgents;
}

/** One "<agent> recently read <files>" phrase per distinct agent. */
function summarizeAgentReads(affectedAgents: Array<{ agent: string; file: string }>): string[] {
	// Deduplicate by agent
	const byAgent = new Map<string, string[]>();
	for (const { agent, file } of affectedAgents) {
		const existing = byAgent.get(agent) || [];
		existing.push(file);
		byAgent.set(agent, existing);
	}

	const agentSummaries: string[] = [];
	for (const [agent, files] of byAgent) {
		const fileList = files.slice(0, 3).join(", ");
		const more = files.length > 3 ? ` +${files.length - 3}` : "";
		agentSummaries.push(`${agent} recently read ${fileList}${more}`);
	}
	return agentSummaries;
}

/**
 * Public API — consumed by structural-checks.runStructuralChecks.
 *
 * Tier 1: Warn when editing a file whose dependents were recently read by another agent.
 */
export function checkCoDependencyStaleness(
	filePath: string,
	relPath: string,
	event: HarnessEvent,
	graph: ProjectGraph,
	sessions: SessionTracker,
	stalenessWindowS: number,
): StructuralCheckResult[] {
	const results: StructuralCheckResult[] = [];
	const agentName = event.agent_name || "";
	const dependents = graph.getDependents(filePath);
	if (dependents.length === 0) return [];

	const stalenessMs = stalenessWindowS * 1000;
	const affectedAgents = collectStaleAgentReads(
		dependents,
		sessions,
		agentName,
		stalenessMs,
		graph,
	);

	if (affectedAgents.length > 0) {
		const agentSummaries = summarizeAgentReads(affectedAgents);

		results.push({
			check: "co_dependency_staleness",
			severity: "info",
			message: `Editing ${relPath} may affect other agents' context: ${agentSummaries.join("; ")}. These files import from ${relPath}.`,
			file: filePath,
			affectedFiles: dependents,
		});
	}

	return results;
}

/** Parameter names declared on a function/method signature line, or [] when there is none. */
function extractSignatureParamNames(line: string): string[] {
	// Find function/method declarations
	const funcMatch = line.match(
		/(?:function\s+\w+|(?:async\s+)?(?:\w+\s*)?(?:=>|\())\s*\(([^)]*)\)/,
	);
	if (!funcMatch) return [];

	// Extract parameter names from the function signature
	const paramStr = funcMatch[1];
	if (!nonNull(paramStr).trim()) return [];
	return nonNull(paramStr)
		.split(",")
		.map((p) => {
			const name = nonNull(p
				.trim()
				.replace(/^\.\.\./, "")
				.split(/[\s:=?]/)[0])
				.trim();
			return name;
		})
		.filter((n) => n && n !== "{" && n !== "}");
}

/** Parameter names tagged in the JSDoc block immediately above line `i`. */
function collectPrecedingJsDocParams(lines: string[], i: number): string[] {
	const jsdocParams: string[] = [];
	for (let j = i - 1; j >= Math.max(0, i - 30); j--) {
		const paramTag = nonNull(lines[j]).match(/@param\s+(?:\{[^}]*\}\s+)?(\w+)/);
		if (paramTag) {
			jsdocParams.push(nonNull(paramTag[1]));
		}
		// Stop at JSDoc start
		if (nonNull(lines[j]).trim().startsWith("/**")) break;
		// Stop at non-comment line
		if (
			!nonNull(lines[j]).trim().startsWith("*") &&
			!nonNull(lines[j]).trim().startsWith("//") &&
			nonNull(lines[j]).trim() !== ""
		) {
			break;
		}
	}
	return jsdocParams;
}

/**
 * Public API — consumed by structural-checks.runStructuralChecks.
 *
 * Detect @param names in JSDoc that don't match function parameter names.
 */
export function checkJSDocParamMismatch(
	filePath: string,
	relPath: string,
): StructuralCheckResult[] {
	const ext = extname(filePath);
	if (![".ts", ".tsx", ".js", ".jsx"].includes(ext)) return [];

	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}

	const results: StructuralCheckResult[] = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const paramNames = extractSignatureParamNames(nonNull(lines[i]));
		if (paramNames.length === 0) continue;

		// Look back for JSDoc @param tags
		const jsdocParams = collectPrecedingJsDocParams(lines, i);
		if (jsdocParams.length === 0) continue;

		// Check for mismatches
		const mismatched = jsdocParams.filter((jp) => !paramNames.includes(jp));
		if (mismatched.length > 0) {
			results.push({
				check: "jsdoc_param_mismatch",
				severity: "warning",
				message: `JSDoc @param "${mismatched.join('", "')}" in ${relPath}:${i + 1} does not match function parameters [${paramNames.join(", ")}].`,
				file: filePath,
			});
		}

		if (results.length >= 5) break;
	}

	return results;
}

/**
 * Public API — consumed by structural-checks.runStructuralChecks.
 *
 * Tier 2: Detect interface/type shape changes and warn about implementors.
 */
export function checkInterfaceChangeImpact(
	filePath: string,
	relPath: string,
	oldBodies: Map<string, string>,
	graph: ProjectGraph,
): StructuralCheckResult[] {
	const newBodies = graph.getInterfaceBodies(filePath);
	const results: StructuralCheckResult[] = [];

	// Find interfaces whose body text changed
	const changedInterfaces: string[] = [];
	for (const [name, oldBody] of oldBodies) {
		const newBody = newBodies.get(name);
		if (!newBody) {
			changedInterfaces.push(name); // Removed
		} else if (oldBody !== newBody) {
			changedInterfaces.push(name); // Modified
		}
	}

	if (changedInterfaces.length === 0) return [];

	// Find files that import the changed interfaces
	const dependents = graph.getDependents(filePath);
	if (dependents.length === 0) return [];

	const importers = graph.getImporters(filePath);
	const affectedFiles: string[] = [];
	for (const edge of importers) {
		const usesChanged = edge.symbols.some((s) => changedInterfaces.includes(s));
		if (usesChanged) {
			affectedFiles.push(edge.fromFile);
		}
	}

	if (affectedFiles.length > 0) {
		const names = changedInterfaces.slice(0, 4).join(", ");
		const more = changedInterfaces.length > 4 ? ` +${changedInterfaces.length - 4}` : "";
		const fileList = affectedFiles
			.slice(0, 6)
			.map((f) => graph.toRelative(f))
			.join(", ");
		const fileMore = affectedFiles.length > 6 ? ` and ${affectedFiles.length - 6} more` : "";

		results.push({
			check: "interface_change_impact",
			severity: "warning",
			message: `Interface/type \`${names}${more}\` changed in ${relPath}. Imported by: ${fileList}${fileMore}. Verify implementations are updated.`,
			file: filePath,
			affectedFiles,
		});
	}

	return results;
}

/**
 * Public API — consumed by structural-checks.runStructuralChecks.
 *
 * Tier 2: Warn when edited source file has no corresponding test file.
 */
export function checkTestProximity(
	filePath: string,
	relPath: string,
	event: HarnessEvent,
	sessions: SessionTracker,
): StructuralCheckResult[] {
	const results: StructuralCheckResult[] = [];
	const ext = extname(filePath);
	const base = basename(filePath, ext);

	// Skip if the file IS a test file
	if (base.endsWith(".test") || base.endsWith(".spec")) return [];
	// Skip non-source files (configs, declarations, etc.)
	if (base.endsWith(".d") || base === "index") return [];
	// Skip generated/output directories that aren't hand-written source
	const norm = relPath.replace(/\\/g, "/");
	if (
		norm.includes(".interlinked/") ||
		norm.includes("dist/") ||
		norm.includes("node_modules/") ||
		norm.includes(".next/") ||
		norm.includes("build/")
	)
		return [];

	const dir = dirname(filePath);
	const testCandidates = [
		join(dir, `${base}.test${ext}`),
		join(dir, `${base}.spec${ext}`),
		join(dir, "__tests__", `${base}.test${ext}`),
		join(dir, "__tests__", `${base}.spec${ext}`),
	];

	const testFile = testCandidates.find((t) => existsSync(t));

	if (!testFile) {
		results.push({
			check: "test_proximity",
			severity: "info",
			message: `No test file found for ${relPath}. Consider adding ${base}.test${ext}.`,
			file: filePath,
		});
		return results;
	}

	// Test file exists — check if agent has updated it during this session
	const agentName = event.agent_name || "";
	const sess = sessions.getAll().find((s) => s.agent_name === agentName);
	if (sess && !sess.files_written.has(testFile)) {
		// Check if the export surface actually changed (worth updating tests for)
		// This is already covered by export_surface check, so only add a gentle reminder
		const relTest = resolve(dir, testFile);
		results.push({
			check: "test_proximity",
			severity: "info",
			message: `${relPath} was modified but its test file hasn't been updated in this session. Test: ${basename(testFile)}`,
			file: filePath,
			affectedFiles: [relTest],
		});
	}

	return results;
}
