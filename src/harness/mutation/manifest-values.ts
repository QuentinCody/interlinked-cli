import { isJsonObject } from "../../lib/json-types.js";
import {
    wireAbsentOptional, wireArray, wireBoolean, wireLiteral, wireNumber,
    wireObject, wireRecord, wireString, wireUnknown,
} from "../../lib/value-validation.js";
import type { IdentityInstability, MeasurementProvenance, MutantRecord, SymbolRecord } from "./types.js";

const isMutant = wireObject<MutantRecord>({
    mutantId: wireString, siteId: wireString, mutator: wireString,
    originalLexeme: wireString, replacement: wireString,
    ordinalWithinSymbol: wireNumber,
    status: wireLiteral("killed", "survived", "timeout", "uncovered", "equivalent", "indeterminate"),
    firstSeen: wireString,
    accepted_reason: wireAbsentOptional(wireString),
    // Persist newer or partial judgments verbatim; dispositionOf interprets them.
    disposition: wireAbsentOptional(wireUnknown),
});

const isInstability = wireObject<IdentityInstability>({
    events: wireArray(wireObject({ at: wireString, kind: wireLiteral("id_churn", "status_flip") })),
    consecutiveStableRuns: wireNumber,
    quarantined: wireBoolean,
});

const isSymbol = wireObject<SymbolRecord>({
    symbolId: wireString, qualifiedName: wireString, symbolHash: wireString,
    mutants: wireRecord(isMutant), instability: isInstability,
});

/** Validate in place: a bad row makes the manifest corrupt, never partially adopted. */
export const isManifestFiles = wireRecord(wireRecord(isSymbol));

const isManifestProvenance = wireRecord(wireObject<MeasurementProvenance>({
    at: wireString,
    scope: wireLiteral("import_graph", "companion_fallback", "glob_fallback", "unknown"),
    testCount: wireNumber,
    surface: wireLiteral("per_edit", "measure", "sweep", "adopt", "unknown"),
    engine: wireAbsentOptional(wireString), engineVersion: wireAbsentOptional(wireString),
}));

/** Preserve legacy omission/defaulting, but never silently discard an invalid entry. */
export function readManifestProvenance(value: unknown): Record<string, MeasurementProvenance> | undefined {
    if (!isJsonObject(value)) return undefined;
    if (!isManifestProvenance(value)) throw new Error("manifest contains an invalid file provenance record");
    return value;
}
