import { BEHAVIORAL_CHECK_META, QUALITY_CHECK_META, STRUCTURAL_CHECK_META, SUGGESTION_CHECK_META } from "../../harness/check-metadata.js";
import { CHECK_REGISTRY } from "../../harness/check-registry/index.js";
import { BUILTIN_RULES } from "../../harness/rules/builtin-rules.js";
import { ALL_SEQUENCE_DETECTORS } from "../../harness/sequence-checks/registry.js";
import { SPEC_LEDGER_CHECK_KINDS } from "../../harness/spec/ledger-drift.js";

export interface CatalogSource { key: string; id: string; family: string; name: string; determinism: string; }

function metadataRows(family: string, meta: Record<string, { name: string; determinism: string }>): CatalogSource[] {
    return Object.entries(meta).map(([id, value]) => ({ key: `${family}:${id}`, id, family, ...value }));
}

export function catalogSources(): CatalogSource[] {
    const rows: CatalogSource[] = CHECK_REGISTRY.map(check => ({ key: `inline:${check.id}`, id: check.id,
        family: "inline", name: check.name, determinism: check.determinism }));
    rows.push(...metadataRows("structural", STRUCTURAL_CHECK_META), ...metadataRows("tool_quality", QUALITY_CHECK_META),
        ...metadataRows("suggestion", SUGGESTION_CHECK_META), ...metadataRows("behavioral", BEHAVIORAL_CHECK_META));
    for (const check of ALL_SEQUENCE_DETECTORS) rows.push({ key: `sequence:${check.id}`, id: check.id,
        family: "sequence", name: check.id, determinism: "session-dependent" });
    for (const id of SPEC_LEDGER_CHECK_KINDS) rows.push({ key: `spec_ledger:${id}`, id, family: "spec_ledger", name: id, determinism: "context-dependent" });
    for (const rule of BUILTIN_RULES) rows.push({ key: `guard:${rule.id}`, id: rule.id,
        family: "guard", name: rule.id, determinism: "session-dependent" });
    return rows.sort((a, b) => a.key.localeCompare(b.key));
}
