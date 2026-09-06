// ===========================================
// Shadow protocol v1 — the canonical record registry
// ===========================================
// ONE runtime list of every public protocol record: its id, where its bytes
// come from, the TS type that declares it, and the parser that is the only
// legal way to mint it. Decision D1 (memo §8.0, first bullet) says the
// cross-repository artifact is REGENERATED from the product declarations —
// this table is what the generator reads, so the artifact can never be a
// second, hand-maintained description of the protocol.
//
// The registry is a MAP, not a new description: it names the parser and the
// declaring type, and adds nothing a reader would have to trust separately.
// `registry.test.ts` proves the id set equals the exported record types the
// `types-*.ts` modules declare, so a new record cannot be added invisibly.
//
// `kind` is the DECODE SOURCE, taken from the frozen module split rather than
// invented here:
//   wire      — parse-transport.ts / parse-outcome.ts / parse-core.ts:
//               bodies and payloads that cross the daemon↔broker boundary.
//   persisted — parse-records.ts / parse-records-store.ts: records read back
//               from storage (D1 / R2 / a Durable Object) or from
//               agent-writable local state.
//   internal  — parse-core-entries.ts: content entries and manifests the
//               daemon computes and always ships INSIDE another record.
// The kind says where the bytes came from, never how far they can be trusted:
// every record here is decoded strictly, and an accepted record is still
// untrusted evidence.

import type { FieldSpec, ShadowParseOutcome } from "./parse-core-entries.js";
import {
	parseManifestEntry,
	parseOverlayEntry,
	parseOverlayManifest,
	parsePostImageEntry,
	RECORD_FIELD_TABLES as ENTRY_TABLES,
} from "./parse-core-entries.js";
import { RECORD_FIELD_TABLES as CORE_TABLES } from "./parse-core.js";
import { RECORD_FIELD_TABLES as OUTCOME_TABLES } from "./parse-outcome-tables.js";
import { RECORD_FIELD_TABLES as RECORDS_TABLES } from "./parse-records.js";
import { RECORD_FIELD_TABLES as STORE_TABLES } from "./parse-records-store.js";
import { RECORD_FIELD_TABLES as TRANSPORT_TABLES } from "./parse-transport-tables.js";
import {
	parseDependencyRequest,
	parseExecutionManifest,
	parseExpectedExecutionPolicy,
	parseNormalizedToolInput,
	parseResolvedDependencyBinding,
	parseShadowChangeSet,
	parseShadowExecutionBinding,
	parseShadowExecutionClaim,
	parseShadowFreshnessBinding,
} from "./parse-core.js";
import { parseAuthoringAttestation, parseCompleteTscResult, parseShadowOutcome } from "./parse-outcome.js";
import {
	parseDeletionReceipt,
	parseLocalFreshnessCheck,
	parseMirrorStatus,
	parseRetentionConsent,
	parseScannerPolicy,
	parseShadowEnv,
	parseShadowExecConfig,
} from "./parse-records.js";
import { parseDependencyTreeCacheRecord, parseMirrorBinding } from "./parse-records-store.js";
import {
	parseCancelAck,
	parseCancelRequest,
	parseManifestUploadInitRequest,
	parseManifestUploadInitResponse,
	parseMirrorFinalizeRequest,
	parseMirrorFinalizeResponse,
	parseMirrorFinalizeStatusResponse,
	parseMirrorPrepareRequest,
	parseMirrorPrepareResponse,
	parseMissingBlobPage,
	parseMissingBlobPageRequest,
	parseMissingBlobPageResponse,
	parseShadowExecutionRequest,
	parseShadowInputFinalizeRequest,
	parseShadowInputFinalizeResponse,
	parseShadowInputPrepareRequest,
	parseShadowInputPrepareResponse,
} from "./parse-transport.js";

/** Where a record's bytes come from. Ordered loosest-origin first. */
export const SHADOW_RECORD_KINDS = ["wire", "persisted", "internal"] as const;
export type ShadowRecordKind = (typeof SHADOW_RECORD_KINDS)[number];

/** A parser as the registry sees it. Each concrete parser returns
 *  `ShadowParseOutcome<ConcreteRecord>`, which widens to this without a cast. */
export type ShadowRecordParser = (raw: unknown) => ShadowParseOutcome<unknown>;

export interface ShadowRecordDescriptorV1 {
	/** The label the parser itself passes to `parseRecord` — the id is the
	 *  same string that prefixes every rejection reason for this record. */
	readonly id: string;
	readonly kind: ShadowRecordKind;
	/** The exported type that DECLARES the record. */
	readonly typeName: string;
	/** The `types-*.ts` module the declaration lives in. */
	readonly typeModule: string;
	readonly parse: ShadowRecordParser;
	/**
	 * The record's declared field tables — ONE per union variant, taken from
	 * the parser's own `RECORD_FIELD_TABLES` export, so the registry publishes
	 * the very arrays the parser validates against and the two cannot disagree.
	 * A single-shape record has exactly one table; a union has one per variant,
	 * and its declared key set is their union.
	 *
	 * `null` means PARSER-ONLY: no table is published for the id at all. No
	 * record is parser-only today, and `registry.test.ts` N4 pins that at zero
	 * so a new record cannot be added without publishing its keys.
	 */
	readonly fields: readonly (readonly FieldSpec[])[] | null;
}

/** One registry row in declaration order. The field tables are NOT a seventh
 *  column — they are looked up by id in `FIELD_TABLES`, so a row can never name
 *  one record and carry another's keys. */
type RegistryRow = readonly [
	id: string,
	kind: ShadowRecordKind,
	typeName: string,
	typeModule: string,
	parse: ShadowRecordParser,
];

/** Every parse module's published key sets, merged by record id. The six maps
 *  are disjoint by construction — each module owns the records it parses — and
 *  `registry.test.ts` N5 fails if a key here names no registered record. */
const FIELD_TABLES: Record<string, readonly (readonly FieldSpec[])[]> = {
	...ENTRY_TABLES,
	...CORE_TABLES,
	...OUTCOME_TABLES,
	...RECORDS_TABLES,
	...STORE_TABLES,
	...TRANSPORT_TABLES,
};

function toDescriptor(row: RegistryRow): ShadowRecordDescriptorV1 {
	const [id, kind, typeName, typeModule, parse] = row;
	return { id, kind, typeName, typeModule, parse, fields: FIELD_TABLES[id] ?? null };
}

/** The declared key set of one record: the union of its variants' keys, in
 *  first-declared order. */
export function declaredKeys(descriptor: ShadowRecordDescriptorV1): readonly string[] {
	const keys = new Set<string>();
	for (const table of descriptor.fields ?? []) {
		for (const [key] of table) keys.add(key);
	}
	return [...keys];
}

const CORE = "types-core.ts";
const BIND = "types-binding.ts";
const OUT = "types-outcome.ts";
const LIFE = "types-lifecycle.ts";
const WIRE = "types-transport.ts";
const ATT = "types-attestation.ts";

/** THE registry. One row per record; nothing else may claim to be the list. */
const ROWS: readonly RegistryRow[] = [
	// content entries and manifests — parse-core-entries.ts
	["manifest_entry", "internal", "ManifestEntryV1", CORE, parseManifestEntry],
	["overlay_entry", "internal", "OverlayEntryV1", CORE, parseOverlayEntry],
	["post_image_entry", "internal", "PostImageEntryV1", CORE, parsePostImageEntry],
	["overlay_manifest", "internal", "OverlayManifestV1", CORE, parseOverlayManifest],
	// claims, policies, bindings — parse-core.ts
	["dependency_request", "wire", "DependencyRequestV1", CORE, parseDependencyRequest],
	["resolved_dependency_binding", "wire", "ResolvedDependencyBindingV1", CORE, parseResolvedDependencyBinding],
	["execution_manifest", "wire", "ExecutionManifestV1", CORE, parseExecutionManifest],
	["change_set", "wire", "ShadowChangeSetV1", CORE, parseShadowChangeSet],
	["tool_input", "wire", "NormalizedToolInputV1", CORE, parseNormalizedToolInput],
	["execution_claim", "wire", "ShadowExecutionClaimV1", BIND, parseShadowExecutionClaim],
	["expected_policy", "wire", "ExpectedExecutionPolicyV1", BIND, parseExpectedExecutionPolicy],
	["execution_binding", "wire", "ShadowExecutionBinding", BIND, parseShadowExecutionBinding],
	["freshness_binding", "wire", "ShadowFreshnessBinding", BIND, parseShadowFreshnessBinding],
	// verifier result, attestation, outcome — parse-outcome.ts
	["verifier_result", "wire", "CompleteShadowTscResultV1", OUT, parseCompleteTscResult],
	["attestation", "wire", "AuthoringAttestationV1", ATT, parseAuthoringAttestation],
	["outcome", "wire", "ShadowOutcome", OUT, parseShadowOutcome],
	// local state and broker-owned policy — parse-records.ts
	["exec_config", "persisted", "ShadowExecConfigV1", CORE, parseShadowExecConfig],
	["scanner_policy", "persisted", "ScannerPolicyV1", CORE, parseScannerPolicy],
	["shadow_env", "persisted", "ShadowEnvV1", BIND, parseShadowEnv],
	["local_freshness_check", "persisted", "LocalFreshnessCheckV1", BIND, parseLocalFreshnessCheck],
	["retention_consent", "persisted", "RetentionConsentV1", LIFE, parseRetentionConsent],
	["mirror_status", "persisted", "MirrorStatusV1", LIFE, parseMirrorStatus],
	["deletion_receipt", "persisted", "DeletionReceipt", LIFE, parseDeletionReceipt],
	// stored records — parse-records-store.ts
	["dependency_cache_record", "persisted", "DependencyTreeCacheRecordV1", CORE, parseDependencyTreeCacheRecord],
	["mirror_binding", "persisted", "MirrorBindingV1", WIRE, parseMirrorBinding],
	// the daemon↔broker wire — parse-transport.ts
	["manifest_upload_init_request", "wire", "ManifestUploadInitRequestV1", WIRE, parseManifestUploadInitRequest],
	["manifest_upload_init_response", "wire", "ManifestUploadInitResponseV1", WIRE, parseManifestUploadInitResponse],
	["missing_blob_page", "wire", "MissingBlobPageV1", WIRE, parseMissingBlobPage],
	["missing_blob_page_request", "wire", "MissingBlobPageRequestV1", WIRE, parseMissingBlobPageRequest],
	["missing_blob_page_response", "wire", "MissingBlobPageResponseV1", WIRE, parseMissingBlobPageResponse],
	["mirror_prepare_request", "wire", "MirrorPrepareRequestV1", WIRE, parseMirrorPrepareRequest],
	["mirror_prepare_response", "wire", "MirrorPrepareResponseV1", WIRE, parseMirrorPrepareResponse],
	["mirror_finalize_request", "wire", "MirrorFinalizeRequestV1", WIRE, parseMirrorFinalizeRequest],
	["mirror_finalize_response", "wire", "MirrorFinalizeResponseV1", WIRE, parseMirrorFinalizeResponse],
	["mirror_finalize_status", "wire", "MirrorFinalizeStatusResponseV1", WIRE, parseMirrorFinalizeStatusResponse],
	["input_prepare_request", "wire", "ShadowInputPrepareRequestV1", WIRE, parseShadowInputPrepareRequest],
	["input_prepare_response", "wire", "ShadowInputPrepareResponseV1", WIRE, parseShadowInputPrepareResponse],
	["input_finalize_request", "wire", "ShadowInputFinalizeRequestV1", WIRE, parseShadowInputFinalizeRequest],
	["input_finalize_response", "wire", "ShadowInputFinalizeResponseV1", WIRE, parseShadowInputFinalizeResponse],
	["execution_request", "wire", "ShadowExecutionRequestV1", WIRE, parseShadowExecutionRequest],
	["cancel_request", "wire", "CancelRequestV1", WIRE, parseCancelRequest],
	["cancel_ack", "wire", "CancelAckV1", WIRE, parseCancelAck],
];

export const SHADOW_RECORD_REGISTRY: readonly ShadowRecordDescriptorV1[] = ROWS.map(toDescriptor);

const BY_ID = new Map(SHADOW_RECORD_REGISTRY.map((descriptor) => [descriptor.id, descriptor]));

/** Declaration order — the generator sorts, so callers get a stable list. */
export function shadowRecordIds(): readonly string[] {
	return SHADOW_RECORD_REGISTRY.map((descriptor) => descriptor.id);
}

export function descriptorFor(id: string): ShadowRecordDescriptorV1 | null {
	return BY_ID.get(id) ?? null;
}

export function shadowRecordsOfKind(kind: ShadowRecordKind): readonly ShadowRecordDescriptorV1[] {
	return SHADOW_RECORD_REGISTRY.filter((descriptor) => descriptor.kind === kind);
}

/** Records whose declared key set the registry cannot publish yet (DR-1). The
 *  gap is data, not prose: `registry.test.ts` N4 pins its size. */
export function parserOnlyRecordIds(): readonly string[] {
	return SHADOW_RECORD_REGISTRY.filter((descriptor) => descriptor.fields === null).map((descriptor) => descriptor.id);
}
