import { join } from "node:path";
import { CHECK_REGISTRY } from "../../harness/check-registry/index.js";
import type { CheckRegistration, InlineMatch, InlineSourceEvidence } from "../../harness/check-registry/types.js";
import { withCheckRoot } from "../../harness/checks/check-root.js";
import { withForegroundCheckScan } from "../../harness/checks/check-scan-policy.js";
import { parseTsSource } from "../../harness/checks/cyclomatic-ast.js";
import { type FileSuppressions, loadFileSuppressions, scanInlineSuppressions } from "../../harness/suppressions.js";
import { hashBytes } from "../metrics/inventory.js";
import type { InventoryFile, SourceRole } from "../metrics/measurement-types.js";
import { scanStandardsSyntax } from "./syntax.js";

export interface StandardsOccurrence {
	id: string;
	unitIds: string[];
	file: string;
	role: SourceRole;
	sourceHash: string;
	sourceEvidence?: InlineSourceEvidence[];
	rule: string;
	kind: "ast_occurrence" | "detector_match" | "semantic_candidate";
	determinism: CheckRegistration["determinism"] | null;
	line: number;
	column: number | null;
	endLine: number | null;
	startOffset: number | null;
	endOffset: number | null;
	text: string;
	detail: string | null;
	suppressed: boolean;
	suppression: "inline" | "file" | null;
	suppressionState?: "known" | "unknown";
}
interface SuppressionCapture { state: "read" | "missing" | "invalid"; forFile: (file: string) => FileSuppressions; }
export interface StandardsCheckCoverage {
	id: string;
	detectorHash: string | null;
	determinism: CheckRegistration["determinism"] | null;
	eligibleFiles: number;
	measuredFiles: number;
	unknownFiles: number;
}
export interface StandardsEvidence {
	occurrences: StandardsOccurrence[];
	checks: StandardsCheckCoverage[];
	syntax: { eligibleFiles: number; measuredFiles: number; unknownFiles: number };
	notMeasured: string[];
}

function identify(row: Omit<StandardsOccurrence, "id" | "unitIds">): StandardsOccurrence {
	return { id: hashBytes(JSON.stringify(row)), unitIds: [], ...row };
}

function syntaxEvidence(file: InventoryFile, report: StandardsEvidence): void {
	const syntax = scanStandardsSyntax(file.content, file.path);
	report.syntax[syntax.state === "measured" ? "measuredFiles" : "unknownFiles"]++;
	report.notMeasured.push(...syntax.notMeasured.map(reason => `${file.path}: ${reason}`));
	for (const match of syntax.findings) report.occurrences.push(identify({ ...match, file: file.path, role: file.role, sourceHash: file.sha256,
		determinism: null, suppressed: false, suppression: null }));
}

function detectorOccurrence(
	file: InventoryFile, check: CheckRegistration, match: InlineMatch,
	suppression: StandardsOccurrence["suppression"], captureState: SuppressionCapture["state"] | undefined,
): StandardsOccurrence {
	return identify({ file: file.path, role: file.role, sourceHash: file.sha256, rule: check.id,
		...(match.sourceEvidence ? { sourceEvidence: match.sourceEvidence.map(source => ({ ...source })) } : {}),
		kind: check.determinism === "fully_deterministic" ? "detector_match" : "semantic_candidate", determinism: check.determinism,
		line: match.line, column: null, endLine: match.endLine ?? null, startOffset: match.startOffset ?? null, endOffset: match.endOffset ?? null,
		text: match.text, detail: check.description, suppressed: suppression !== null, suppression,
		...(captureState ? { suppressionState: captureState === "invalid" && suppression === null ? "unknown" as const : "known" as const } : {}) });
}

function detectorEvidence(root: string, file: InventoryFile, check: CheckRegistration, coverage: StandardsCheckCoverage, report: StandardsEvidence, capture?: SuppressionCapture): void {
	try {
		const run = withForegroundCheckScan(() => withCheckRoot(root, () => check.fn(file.content, join(root, file.path))));
		for (const reason of run.notMeasured) report.notMeasured.push(`${file.path}: ${reason}`);
		const inline = scanInlineSuppressions(file.content), suppressed = capture ? capture.forFile(file.path) : loadFileSuppressions(join(root, ".interlinked"), file.path);
		for (const match of run.result) {
			const suppression = suppressed.has(check.id) ? "file" : inline.get(match.line)?.has(check.id) ? "inline" : null;
			report.occurrences.push(detectorOccurrence(file, check, match, suppression, capture?.state));
		}
		coverage[run.notMeasured.length ? "unknownFiles" : "measuredFiles"]++;
	} catch (error) {
		coverage.unknownFiles++;
		report.notMeasured.push(`${file.path}: ${check.id}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Run selected existing detectors over captured JS/TS text and preserve every raw occurrence. */
export function scanStandardsEvidence(root: string, files: readonly InventoryFile[], checkIds: readonly string[], registry: readonly CheckRegistration[] = CHECK_REGISTRY, capture?: SuppressionCapture): StandardsEvidence {
	const report: StandardsEvidence = { occurrences: [], checks: [], syntax: { eligibleFiles: files.length, measuredFiles: 0, unknownFiles: 0 }, notMeasured: [] };
	for (const file of files) syntaxEvidence(file, report);
	const parserAvailable = parseTsSource("", "availability.ts") !== null;
	for (const id of new Set(checkIds)) {
		const check = registry.find(entry => entry.id === id);
		const coverage: StandardsCheckCoverage = { id, detectorHash: check ? hashBytes(check.fn.toString()) : null, determinism: check?.determinism ?? null,
			eligibleFiles: files.length, measuredFiles: 0, unknownFiles: 0 };
		report.checks.push(coverage);
		if (!check || !parserAvailable) {
			coverage.unknownFiles = files.length;
			report.notMeasured.push(`${id}: ${check ? "Optional CLI TypeScript compiler unavailable, target compiler loading disabled" : "Registry detector unavailable"}`);
			continue;
		}
		for (const file of files) detectorEvidence(root, file, check, coverage, report, capture);
	}
	return report;
}
