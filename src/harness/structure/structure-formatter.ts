// ===========================================
// Generic Artifact Structure V1 — Human-Readable Structure Output
// ===========================================
// Formats structure findings for stderr output (PostToolUse warnings)
// and for verify JSON output.

import type {
	Determinism,
	StructureConfig,
	StructureFinding,
	StructureVerifyOutput,
} from "./types.js";

// -------------------------------------------
// Determinism sort order
// -------------------------------------------

const DETERMINISM_ORDER: Record<Determinism, number> = {
	fully_deterministic: 0,
	partially_deterministic: 1,
	heuristic: 2,
};

// -------------------------------------------
// Format warnings for stderr (PostToolUse)
// -------------------------------------------

export function formatStructureWarnings(findings: StructureFinding[]): string[] {
	const sorted = [...findings].sort(
		(a, b) => DETERMINISM_ORDER[a.determinism] - DETERMINISM_ORDER[b.determinism],
	);

	return sorted.map(formatSingleWarning);
}

function formatSingleWarning(finding: StructureFinding): string {
	const lines: string[] = [];
	lines.push(`[interlinked:structure] ${finding.name}`);
	lines.push(`  file: ${finding.file}`);
	const localId = finding.artifact_id.includes(":")
		? finding.artifact_id.split(":").slice(1).join(":")
		: finding.artifact_id;
	lines.push(`  artifact: ${finding.artifact_kind} ${localId}`);
	lines.push(`  determinism: ${finding.determinism}`);
	lines.push(`  provenance: ${finding.provenance}`);

	if (finding.required_updates.length > 0) {
		lines.push("  required follow-ups:");
		for (const update of finding.required_updates) {
			lines.push(`    - ${update.file} (${update.kind})`);
		}
	}

	return lines.join("\n");
}

// -------------------------------------------
// Format verify JSON output
// -------------------------------------------

interface VerifyOutputOptions {
	config: StructureConfig | null;
	findings: StructureFinding[];
	invalidFiles: string[];
	adoption: Record<string, number>;
	catalogFresh: boolean;
}

export function formatStructureVerifyOutput(opts: VerifyOutputOptions): StructureVerifyOutput {
	const mode = opts.config?.mode ?? "minimal";
	const counts = countByDeterminism(opts.findings);
	const details = opts.findings.map((f) => ({
		name: f.name,
		determinism: f.determinism,
		provenance: f.provenance,
		file: f.file,
		artifact_id: f.artifact_id,
		required_updates: f.required_updates,
	}));

	return {
		mode,
		catalog_fresh: opts.catalogFresh,
		invalid_files: opts.invalidFiles,
		adoption: opts.adoption,
		findings: counts,
		details,
	};
}

function countByDeterminism(findings: StructureFinding[]): Record<Determinism, number> {
	const counts: Record<Determinism, number> = {
		fully_deterministic: 0,
		partially_deterministic: 0,
		heuristic: 0,
	};
	for (const f of findings) {
		counts[f.determinism]++;
	}
	return counts;
}
