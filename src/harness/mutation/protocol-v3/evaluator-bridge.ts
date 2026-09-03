// ===========================================
// Protocol v3 — authenticated evidence → local evaluator bridge
// ===========================================
// The cloud reports mechanical observations. It never gets to mint the local
// mutation verdict or stable-manifest identity. This bridge accepts ONLY the
// authenticated bundle, re-derives the full v2 wire identities from the
// caller's hash-bound target content, and returns raw mutants for the existing
// evaluator. evaluate.ts then independently derives the legacy v1 manifest
// keys and owns baseline/policy semantics.

import { createHash } from "node:crypto";
import type { AdaptedMutant, MutationRunOutput } from "../stryker-adapter.js";
import {
	derivePortableIdentities,
	PORTABLE_IDENTITY_ALGORITHM,
	type PortableMutantIdentity,
} from "../identity.js";
import type { RawMutant } from "../types.js";
import type { V3ExcludedRow, V3MutantIdentityProvenance, V3MutantRow } from "./types.js";
import { IDENTITY_ALGORITHM } from "./types.js";
import { isVerifiedEvidenceBundle, type VerifiedEvidenceBundle } from "./verify.js";

export type V3EvaluatorBridgeOutcome =
	| { ok: true; run: MutationRunOutput }
	| { ok: false; reason: string };

function targetHash(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function rowsIn(bundle: VerifiedEvidenceBundle): readonly V3MutantRow[] {
	const envelope = bundle.envelope;
	if (
		envelope.kind === "mutation_result" ||
		envelope.kind === "suite_red" ||
		(envelope.kind === "execution_failed" && envelope.evidence_completeness === "partial")
	) {
		return envelope.mutants ?? [];
	}
	return [];
}

function exclusionsIn(bundle: VerifiedEvidenceBundle): readonly V3ExcludedRow[] {
	const envelope = bundle.envelope;
	if (
		envelope.kind === "mutation_result" ||
		envelope.kind === "suite_red" ||
		(envelope.kind === "execution_failed" && envelope.evidence_completeness === "partial")
	) {
		return envelope.excluded ?? [];
	}
	return [];
}

function rawMutant(file: string, row: V3MutantIdentityProvenance): RawMutant {
	return {
		file,
		mutator: row.mutator,
		originalLexeme: row.original_lexeme,
		replacement: row.replacement,
		startOffset: row.start_offset,
	};
}

function sourceAnchorFailure(content: string, row: V3MutantIdentityProvenance): string | null {
	if (row.start_offset > content.length) {
		return `mutant ${row.mutant_id} starts outside the hash-bound target content`;
	}
	const end = row.start_offset + row.original_lexeme.length;
	if (!Number.isSafeInteger(end) || end > content.length) {
		return `mutant ${row.mutant_id} span extends outside the hash-bound target content`;
	}
	if (content.slice(row.start_offset, end) !== row.original_lexeme) {
		return `mutant ${row.mutant_id} original_lexeme does not match the hash-bound target content`;
	}
	return null;
}

function identityMismatch(row: V3MutantIdentityProvenance, derived: PortableMutantIdentity): string | null {
	const comparisons: Array<[string, unknown, unknown]> = [
		["symbol_id", row.symbol_id, derived.symbolId],
		["site_id", row.site_id, derived.siteId],
		["mutant_id", row.mutant_id, derived.mutantId],
		["qualified_name", row.qualified_name, derived.qualifiedName],
		["symbol_context", row.symbol_context, derived.symbolContext],
		["ordinal_within_symbol", row.ordinal_within_symbol, derived.ordinalWithinSymbol],
	];
	for (const [field, claimed, expected] of comparisons) {
		if (claimed !== expected) {
			return `mutant ${row.mutant_id} ${field} does not match the locally derived ${IDENTITY_ALGORITHM} identity`;
		}
	}
	return null;
}

type IndexIdentityRowEntry = {
	row: V3MutantIdentityProvenance | undefined;
	identity: PortableMutantIdentity | undefined;
	raw: RawMutant | undefined;
};

type IndexIdentityRowResult =
	| { ok: false; reason: string }
	| { ok: true; adaptedMutant: AdaptedMutant | null };

function processIndexIdentityRow(
	entry: IndexIdentityRowEntry,
	isExecutableRow: boolean,
	executable: V3MutantRow | undefined,
): IndexIdentityRowResult {
	const { row, identity, raw } = entry;
	if (row === undefined || identity === undefined || raw === undefined) {
		return { ok: false, reason: "mutant identity derivation returned a short result" };
	}
	const mismatch = identityMismatch(row, identity);
	if (mismatch !== null) return { ok: false, reason: mismatch };
	if (!isExecutableRow) return { ok: true, adaptedMutant: null };
	if (executable === undefined) {
		return { ok: false, reason: "executable mutant mapping returned a short result" };
	}
	return { ok: true, adaptedMutant: { raw, status: executable.status } };
}

function adaptedRows(
	rows: readonly V3MutantRow[],
	excluded: readonly V3ExcludedRow[],
	content: string,
	file: string,
): V3EvaluatorBridgeOutcome {
	const identityRows: readonly V3MutantIdentityProvenance[] = [...rows, ...excluded];
	const raws = identityRows.map((row) => rawMutant(file, row));
	for (const row of identityRows) {
		const anchorFailure = sourceAnchorFailure(content, row);
		if (anchorFailure !== null) return { ok: false, reason: anchorFailure };
	}
	const identities = derivePortableIdentities(file, content, raws);
	if (identities === null) {
		return { ok: false, reason: "typescript unavailable — portable mutant identity cannot be verified" };
	}
	const derivedIds = new Set(identities.map((identity) => identity.mutantId));
	if (derivedIds.size !== identities.length) {
		return { ok: false, reason: "duplicate locally derived mutant identities — evidence is not one row per mutant" };
	}
	const adapted: AdaptedMutant[] = [];
	for (let index = 0; index < identityRows.length; index++) {
		const entry: IndexIdentityRowEntry = { row: identityRows[index], identity: identities[index], raw: raws[index] };
		const isExecutableRow = index < rows.length;
		const result = processIndexIdentityRow(entry, isExecutableRow, isExecutableRow ? rows[index] : undefined);
		if (!result.ok) return result;
		if (result.adaptedMutant !== null) adapted.push(result.adaptedMutant);
	}
	return { ok: true, run: { mutants: adapted } };
}

type BridgeEnvelope = VerifiedEvidenceBundle["envelope"];

function terminalKindFailure(envelope: BridgeEnvelope): string | null {
	if (
		envelope.kind !== "mutation_result" &&
		envelope.kind !== "not_mutatable" &&
		envelope.kind !== "suite_red" &&
		envelope.kind !== "execution_failed"
	) {
		return `terminal kind ${envelope.kind} carries no evaluator mutation run`;
	}
	return null;
}

function deriveTestRun(
	envelope: BridgeEnvelope,
): { overlayGreen: boolean; redWitnessSatisfied: boolean | null } | undefined {
	return "test_run" in envelope
		? {
			overlayGreen: envelope.test_run.overlay_green,
			redWitnessSatisfied: envelope.test_run.red_witness_satisfied,
		}
		: undefined;
}

function deriveEngineExitCode(envelope: BridgeEnvelope): number | undefined {
	return "engine" in envelope ? envelope.engine.exit_code : undefined;
}

function deriveExecutedTestCount(envelope: BridgeEnvelope): number | undefined {
	return "test_run" in envelope ? envelope.test_run.executed_test_count : undefined;
}

function buildRunOutput(
	bridgedRun: MutationRunOutput,
	testRun: { overlayGreen: boolean; redWitnessSatisfied: boolean | null } | undefined,
	engineExitCode: number | undefined,
	executedTestCount: number | undefined,
	exclusions: readonly V3ExcludedRow[],
): MutationRunOutput {
	return {
		...bridgedRun,
		...(testRun === undefined ? {} : { testRun }),
		...(engineExitCode === undefined ? {} : { engineExitCode }),
		...(executedTestCount === undefined ? {} : { executedTestCount }),
		droppedMutants: 0,
		...(exclusions.length === 0
			? {}
			: {
				evidenceGaps: [
					`approved exclusion rows are not executable mutant evidence (${exclusions.length} excluded mutant(s))`,
				],
			}),
	};
}

/** Convert authenticated v3 evidence into the raw mechanical input expected
 * by evaluate.ts. The caller must provide the exact local overlay bytes it
 * submitted; a hash mismatch refuses before any identity or policy work. */
export function authenticatedEvidenceToMutationRun(
	bundle: VerifiedEvidenceBundle,
	targetContent: string,
): V3EvaluatorBridgeOutcome {
	if (!isVerifiedEvidenceBundle(bundle)) {
		return { ok: false, reason: "protocol-v3 evidence bundle was not minted by the verifier" };
	}
	if (IDENTITY_ALGORITHM !== PORTABLE_IDENTITY_ALGORITHM) {
		return { ok: false, reason: "protocol identity constant disagrees with the identity implementation" };
	}
	const envelope = bundle.envelope;
	if (targetHash(targetContent) !== envelope.job.target_content_hash) {
		return { ok: false, reason: "local target content does not match the authenticated job target_content_hash" };
	}
	const exclusions = exclusionsIn(bundle);
	const bridged = adaptedRows(rowsIn(bundle), exclusions, targetContent, envelope.job.target_file);
	if (!bridged.ok) return bridged;
	const kindFailure = terminalKindFailure(envelope);
	if (kindFailure !== null) {
		return { ok: false, reason: kindFailure };
	}
	const testRun = deriveTestRun(envelope);
	const engineExitCode = deriveEngineExitCode(envelope);
	const executedTestCount = deriveExecutedTestCount(envelope);
	return {
		ok: true,
		run: buildRunOutput(bridged.run, testRun, engineExitCode, executedTestCount, exclusions),
	};
}
