import { checkActions } from "../../lib/check-actions.js";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import type { OutputJsonArgs } from "./output-json.js";

function details(section: JsonObject | undefined): JsonObject[] {
	return Array.isArray(section?.details) ? section.details.filter(isJsonObject) : [];
}

function structureActions(section: JsonObject | undefined): unknown[] {
	if (!section) return [];
	if (typeof section.error === "string") return [{ check: "structure", status: "unavailable", message: section.error }];
	const rows: unknown[] = details(section).flatMap(row => {
		if (typeof row.name !== "string" || typeof row.file !== "string") return [];
		const updates = Array.isArray(row.required_updates) ? row.required_updates.filter(isJsonObject).filter(update => typeof update.file === "string") : [];
		return [{ ...row, subject: row.artifact_id, message: `${row.name}: ${updates.map(update => `${update.file} (${update.kind})`).join(", ") || "Review artifact responsibilities and declared policy."}` }];
	});
	for (const file of Array.isArray(section.invalid_files) ? section.invalid_files : []) {
		if (typeof file === "string") rows.push({ check: "structure_configuration", file, status: "unavailable", message: "Structure configuration could not be validated." });
	}
	return rows;
}

function scenarioActions(section: JsonObject | undefined): unknown[] {
	if (!section || section.status === "unconfigured") return [];
	if (section.status === "unavailable" || section.status === "invalid") return [{ check: "project_e2e", status: "unavailable", message: typeof section.reason === "string" ? section.reason : `Project e2e evaluation is ${section.status}.` }];
	if (!Array.isArray(section.scenarios)) return [];
	return section.scenarios.filter(isJsonObject).flatMap(row => {
		if (typeof row.key !== "string" || row.status === "satisfied") return [];
		const codes = Array.isArray(row.codes) ? row.codes.filter(code => typeof code === "string") : [];
		if (codes.length === 0) return [];
		return [{ check: "project_e2e", subject: row.key, message: `${row.key}: ${String(row.status)} (${codes.join(", ")}).`, fix: "Inspect this scenario with interlinked tests e2e check and satisfy its declared evidence requirements." }];
	});
}

function supplementalActions(args: OutputJsonArgs): unknown[] {
	const rows: unknown[] = [
		...(args.setupIssues ?? []),
		...(args.registryDrift ?? []).map(row => ({ ...row, check: "registry_parity", file: row.source_file, subject: `${row.pair}:${row.kind}:${row.id}` })),
		...(args.suggestions ? [...args.suggestions].flatMap(([file, findings]) => findings.map(row => ({ ...row, file }))) : []),
		...structureActions(args.structureSection), ...scenarioActions(args.projectE2e),
		...unavailableActions(args),
		...(args.unavailableChecks ?? []).map(row => ({ ...row, status: "unavailable", message: row.reason })),
		...details(args.killProofs).flatMap(row => {
			const files = Array.isArray(row.files) ? row.files.filter(file => typeof file === "string") : [];
			return (files.length ? files : ["<project>"]).map(file => ({ ...row, file, subject: row.id }));
		}),
	];
	for (const [check, section] of Object.entries(args.catalogue ?? {})) {
		if (section.unavailable > 0) rows.push({ check, status: "unavailable", message: `${section.unavailable} inputs could not be assessed; ${section.examined} inputs were examined.` });
	}
	if (args.auditResult && args.auditResult.total > 0) rows.push({ check: "dependency_audit", message: `${args.auditResult.tool} reported ${args.auditResult.total} dependency advisories. ${args.auditResult.detail}`, fix: "Inspect affected package versions and reachability in the dependency audit; validate any update with the project's tests." });
	if (args.lockfileMultiplicity?.multiplicity) rows.push({ check: "multiple_lockfiles", message: `Review package-manager ownership for ${args.lockfileMultiplicity.lockfiles.join(", ")}; multiple lockfiles can be intentional in independent workspaces.` });
	for (const message of args.decisionSurfaceRatchet?.warnings ?? []) rows.push({ check: "decision_surface_growth", message });
	return rows;
}

function unavailableActions(args: OutputJsonArgs): unknown[] {
	const rows: unknown[] = (args.checkCoverage?.skipped ?? []).filter(row => row.category !== "config_disabled" && row.category !== "file_type_mismatch").map(row => ({ check: row.check, message: row.reason, status: "unavailable" }));
	for (const scope of args.toolInputScopes ?? []) {
		for (const input of scope.unavailableInputs) rows.push({ check: scope.tool, file: input.file,
			status: "unavailable", message: input.reason, producerRefs: ["/check_coverage/input_scopes"] });
	}
	for (const timing of args.checkTimings ?? []) {
		if (timing.skipped === 0 && timing.errors === 0) continue;
		rows.push({ check: timing.check, subject: "coverage", status: "deferred", message: `${timing.skipped} input(s) deferred and ${timing.errors} execution error(s); only ${timing.unavailable_inputs?.length ?? 0} unavailable input location(s) were retained.` });
		for (const input of timing.unavailable_inputs ?? []) rows.push({ check: timing.check, file: input.file, status: "deferred", message: input.reason });
	}
	return rows;
}

/** Project every retained finding, including coverage gaps; never execute another analyzer. */
export function verifyActions(args: OutputJsonArgs) {
	const diagnostics = (args.externalDiagnostics ?? [...args.tscResults, ...args.linterResults, ...args.semgrepResults, ...args.gitleaksResults]).map(row => ({ ...row, check: row.ruleId ? `${row.tool}:${row.ruleId}` : row.tool }));
	const inventory = checkActions([
		...Object.values(args.cq).flat(), ...diagnostics,
		...Object.values(args.catalogue ?? {}).flatMap(section => section.findings),
		...supplementalActions(args),
	], args.rules?.rules_hash ?? null);
	for (const scope of args.toolInputScopes ?? []) {
		for (const limitation of scope.nativeLimitations ?? []) inventory.limitations.push(`${scope.tool}: ${limitation}`);
	}
	return inventory;
}
