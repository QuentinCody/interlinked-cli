import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captureFileSuppressions, type FileSuppressions } from "../../harness/suppressions.js";
import { standardsActions } from "./actions.js";
import { hashBytes } from "../metrics/inventory.js";
import { measureStandardsCompiler } from "./compiler.js";
import { collectStandardsDiscovery, type StandardsDiscovery } from "./discovery.js";
import { scanStandardsEvidence, type StandardsEvidence, type StandardsOccurrence } from "./evidence.js";
import { collectStandardsInventory, compareStandardsSnapshot, type StandardsInventory } from "./inventory.js";
import { DMMULROY_TYPESCRIPT_PROFILE, type StandardsGroup } from "./profile.js";
import { attachStandardsUnitIds, collectStandardsUnits } from "./units.js";

export interface StandardsCounts {
	astOccurrences: number;
	detectorMatches: number;
	semanticCandidates: number;
	discoveryCandidates: number;
	suppressedMatches: number;
	configurationObservations: number;
}
export interface StandardsMeasurement {
	id: string;
	title: string;
	source: StandardsGroup["source"];
	state: "partial" | "not_measured";
	compliance: null;
	counts: StandardsCounts;
	byRole: Record<string, StandardsCounts>;
	occurrenceIds: string[];
	caseIds: string[];
	coverage: { syntax: StandardsEvidence["syntax"] | null; checks: StandardsEvidence["checks"]; discoveryFiles: number | null; unresolvedCalls: number | null; compilerState: string | null };
	unknowns: string[];
}

function emptyCounts(): StandardsCounts {
	return { astOccurrences: 0, detectorMatches: 0, semanticCandidates: 0, discoveryCandidates: 0, suppressedMatches: 0, configurationObservations: 0 };
}

function countOccurrence(counts: StandardsCounts, row: StandardsOccurrence): void {
	if (row.kind === "ast_occurrence") counts.astOccurrences++;
	if (row.kind === "detector_match") counts.detectorMatches++;
	if (row.kind === "semantic_candidate") counts.semanticCandidates++;
	if (row.suppressed) counts.suppressedMatches++;
}

type FileRoles = ReadonlyMap<string, StandardsInventory["files"][number]["role"]>;

function groupCounts(occurrences: StandardsOccurrence[], cases: StandardsDiscovery["cases"], roles: FileRoles) {
	const counts = emptyCounts(), byRole: Record<string, StandardsCounts> = {};
	for (const row of occurrences) { countOccurrence(counts, row); countOccurrence(byRole[row.role] ??= emptyCounts(), row); }
	for (const candidate of cases) {
		counts.semanticCandidates++; counts.discoveryCandidates++;
		const source = candidate.sources[0];
		const role = source && roles.get(source.file);
		if (role) { const roleCounts = byRole[role] ??= emptyCounts(); roleCounts.semanticCandidates++; roleCounts.discoveryCandidates++; }
	}
	return { counts, byRole };
}

function measureGroup(group: StandardsGroup, roles: FileRoles, evidence: StandardsEvidence, discovery: StandardsDiscovery, compiler: ReturnType<typeof measureStandardsCompiler>): StandardsMeasurement {
	const occurrences = evidence.occurrences.filter(row => row.determinism === null ? group.syntaxRules.includes(row.rule) : group.checkIds.includes(row.rule));
	const cases = discovery.cases.filter(row => group.discoveryFamilies.includes(row.family));
	const { counts, byRole } = groupCounts(occurrences, cases, roles);
	const hasCompiler = group.id === "s25", checks = evidence.checks.filter(row => group.checkIds.includes(row.id));
	if (hasCompiler) counts.configurationObservations = compiler.configs.reduce((sum, config) => sum + Object.values(config.settings).filter(value => value !== null).length, 0);
	const measured = group.syntaxRules.length > 0 && evidence.syntax.measuredFiles > 0 || checks.some(check => check.measuredFiles > 0)
		|| group.discoveryFamilies.length > 0 && discovery.files > 0 || counts.configurationObservations > 0;
	return { id: group.id, title: group.title, source: group.source, state: measured ? "partial" : "not_measured", compliance: null,
		counts, byRole, occurrenceIds: occurrences.map(row => row.id), caseIds: cases.map(row => row.id),
		coverage: { syntax: group.syntaxRules.length ? evidence.syntax : null, checks, discoveryFiles: group.discoveryFamilies.length ? discovery.files : null,
			unresolvedCalls: group.discoveryFamilies.length ? discovery.unresolvedCalls : null, compilerState: hasCompiler ? compiler.state : null },
		unknowns: [group.unmeasured, ...(group.discoveryFamilies.length ? discovery.notMeasured : []), ...(hasCompiler ? compiler.configs.flatMap(config => config.diagnostics.map(reason => `${config.file}: ${reason}`)) : [])] };
}

type SuppressionIdentity = { sha256: string | null; state: "read" | "missing" | "invalid"; reason: string | null };

function captureSuppressionPolicy(root: string): { identity: SuppressionIdentity; forFile: (file: string) => FileSuppressions } {
	const empty = () => new Set<string>();
	try {
		const text = readFileSync(join(root, ".interlinked", "verify-suppressions.json"), "utf8");
		try { return { identity: { sha256: hashBytes(text), state: "read", reason: null }, forFile: captureFileSuppressions(text) }; }
		catch (error) { return { identity: { sha256: hashBytes(text), state: "invalid", reason: error instanceof Error ? error.message : String(error) }, forFile: empty }; }
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { identity: { sha256: null, state: "missing", reason: null }, forFile: empty };
		return { identity: { sha256: null, state: "invalid", reason: error instanceof Error ? error.message : String(error) }, forFile: empty };
	}
}

function compareSuppressionPolicy(root: string, captured: SuppressionIdentity) {
	const final = captureSuppressionPolicy(root).identity;
	const consistency = captured.state === "invalid" || final.state === "invalid" ? "inconclusive"
		: captured.state === final.state && captured.sha256 === final.sha256 ? "stable_capture" : "changed";
	return { ...captured, final, consistency };
}

const LIMITATIONS = ["Counts describe overlapping evidence populations and cannot be summed into unique defects or guideline compliance.", "AST patterns establish written syntax. Identifier names alone do not establish bindings or behavior.", "All discovered source roles remain in the denominator. Only selected readable JS/TS text receives syntax, detector and discovery passes.", "Filesystem fallback follows the shared inventory's dependency, build, vendor and metadata directory exclusions.", "Detector counts are observed matches and remain lower bounds wherever a detector retains traversal or result limits. measuredFiles records detector execution, not complete recognized-site reporting or semantic coverage.", "Detector matches retain raw and suppressed occurrences. Suppression changes affect presentation metadata and establish no policy adoption."];

/** Measure the pinned advisory guidance locally. This operation never adopts policy or requests inference. */
export function collectStandardsReport(directory: string, options: { profile?: string; scope?: string } = {}) {
	const startedAt = new Date().toISOString();
	if (options.profile !== undefined && options.profile !== DMMULROY_TYPESCRIPT_PROFILE.id) throw new Error(`Unknown standards profile: ${options.profile}`);
	if (options.scope !== undefined && options.scope !== "all" && options.scope !== "product") throw new Error("Standards scope must be all or product");
	const inventoryOptions = { resourcePolicy: "foreground-survey" } as const;
	const profile = DMMULROY_TYPESCRIPT_PROFILE, inventory = collectStandardsInventory(directory, options.scope ?? "all", inventoryOptions);
	const suppressions = captureSuppressionPolicy(inventory.root);
	const evidence = scanStandardsEvidence(inventory.root, inventory.files, profile.standards.flatMap(group => [...group.checkIds]), undefined,
		{ state: suppressions.identity.state, forFile: suppressions.forFile });
	const unitEvidence = collectStandardsUnits(inventory.root, inventory.files);
	attachStandardsUnitIds(evidence.occurrences, unitEvidence.units);
	const discovery = collectStandardsDiscovery(inventory.root, inventory.files);
	const compiler = measureStandardsCompiler(inventory.root, inventory.entries.filter(entry => /(?:^|\/)tsconfig(?:\.[^/]*)?\.json$/.test(entry.path)).map(entry => entry.path));
	const roles = new Map(inventory.files.map(file => [file.path, file.role]));
	const standards = profile.standards.map(group => measureGroup(group, roles, evidence, discovery, compiler));
	const sourceConsistency = compareStandardsSnapshot(inventory, inventoryOptions);
	const suppressionPolicy = compareSuppressionPolicy(inventory.root, suppressions.identity);
	const report = { schema: "interlinked.standards-report/1" as const, modelCalls: 0 as const, profile, profileHash: hashBytes(JSON.stringify(profile)),
		provenance: { startedAt, finishedAt: new Date().toISOString(), sourceConsistency }, units: unitEvidence.units,
		inventory: { root: inventory.root, version: inventory.version, scope: inventory.scope, discovery: inventory.discovery, entries: inventory.entries, byRole: inventory.byRole,
			inputHash: inventory.inputHash, selectedFiles: inventory.files.length, gaps: inventory.gaps, issues: inventory.issues },
		standards, occurrences: evidence.occurrences, checks: evidence.checks, syntax: evidence.syntax, discovery, compiler,
		suppressionPolicy,
		notMeasured: [...evidence.notMeasured, ...unitEvidence.notMeasured], limitations: [...LIMITATIONS, ...compiler.limitations, ...discovery.limitations] };
	return { ...report, actions: standardsActions(report) };
}

export type StandardsReport = ReturnType<typeof collectStandardsReport>;
