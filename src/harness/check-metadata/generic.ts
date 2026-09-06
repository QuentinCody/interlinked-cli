// Metadata for generic/inline agent safety checks (PostToolUse, regex-based).
// Keys match the `id` fields of CHECK_REGISTRY entries.
//
// GENERIC_CHECK_META is DERIVED from CHECK_REGISTRY — it is not hand-kept.
// `buildGenericCheckMeta()` projects each registration's name/description/
// tier/determinism, which is exactly the CheckMeta shape. The two used to be
// verbatim copies maintained by hand in ~15 sibling fragment files; they had
// already drifted (227 of 235 shared ids disagreed on name or description
// wording) and two runtime consumers read DIFFERENT copies. Deriving removes
// the drift surface: to change a check's documented name, description, tier,
// or determinism, edit its CHECK_REGISTRY entry in
// `../check-registry/entries-*.ts`.
//
// Only two things stay hand-written here, because CHECK_REGISTRY cannot
// express them:
//   1. ANNOTATION_OVERLAY — the optional `asi` / `externality` documentation
//      annotations, which live on CheckMeta but not on CheckRegistration.
//   2. UNREGISTERED_CHECK_META — ids that are documented but have no
//      CHECK_REGISTRY registration (verify-only detectors and legacy ids).

import { buildGenericCheckMeta } from "../check-registry/builders.js";
import type { CheckMeta, OwaspAsi } from "./types.js";
import type { ToolExternality } from "../types.js";

/**
 * Documentation annotations that `CheckRegistration` has no field for. Keyed
 * by check id; merged on top of the derived entry. An id here MUST exist in
 * the derived or unregistered table — `composeGenericCheckMeta` throws
 * otherwise, so a renamed check can't leave a silent orphan annotation.
 */
const ANNOTATION_OVERLAY: Record<
	string,
	{ asi?: OwaspAsi; externality?: ToolExternality }
> = {
	eval_usage: { asi: "ASI05" },
	inner_html: { asi: "ASI05" },
	dangerously_set_inner_html: { asi: "ASI05" },
	endpoint_auth_missing: { externality: "local_write" },
	endpoint_idor_shape: { externality: "local_write" },
	endpoint_missing_tenant_filter: { externality: "local_write" },
	endpoint_ssrf_shape: { externality: "local_write" },
	endpoint_mass_assignment: { externality: "local_write" },
};

/**
 * Check ids that are documented but carry no CHECK_REGISTRY registration, so
 * nothing can derive their metadata:
 *
 * - `complexity` — the legacy regex complexity signal, superseded at the
 *   registry level by `cognitive_complexity` and the cyclomatic write gate.
 * - `gitignored_written_config`, `spec_path_ref` — verify-only detectors
 *   (`VERIFY_ONLY_CHECKS`); their signatures don't satisfy the registry's
 *   `(content, filePath) => InlineMatch[]` contract.
 * - `c_strcmp_boolean_misuse`, `c_unchecked_malloc` — documented C/C++ shapes
 *   with no shipped detector yet.
 */
const UNREGISTERED_CHECK_META: Record<string, CheckMeta> = {
	complexity: {
		name: "Function Complexity",
		description: "Flags functions with high branch count, deep nesting, or many parameters",
		tier: 2,
		determinism: "heuristic",
	},
	gitignored_written_config: {
		name: "Gitignored Written Config",
		description:
			"Detects code that writes a statically-resolvable config path which .gitignore excludes with no `!` carve-out — the file can never be committed.",
		tier: 2,
		determinism: "partially_deterministic",
	},
	spec_path_ref: {
		name: "Spec Path Reference",
		description:
			"Detects a file path referenced in prose/spec markdown that does not resolve in the working tree.",
		tier: 2,
		determinism: "partially_deterministic",
	},
	c_strcmp_boolean_misuse: {
		name: "C strcmp Boolean Misuse",
		description: "Detects strcmp return value used as boolean without comparison",
		tier: 1,
		determinism: "partially_deterministic",
	},
	c_unchecked_malloc: {
		name: "C Unchecked Malloc",
		description: "Detects malloc/calloc/realloc without null check",
		tier: 2,
		determinism: "partially_deterministic",
	},
};

/**
 * Exported (with defaults that reproduce the module's own real derivation)
 * so the companion test can drive the orphan-annotation guard directly: the
 * real `ANNOTATION_OVERLAY` never names an unknown id, so the throw below
 * is otherwise unreachable through `GENERIC_CHECK_META` alone.
 */
export function composeGenericCheckMeta(
	overlay: Record<string, { asi?: OwaspAsi; externality?: ToolExternality }> = ANNOTATION_OVERLAY,
	unregistered: Record<string, CheckMeta> = UNREGISTERED_CHECK_META,
): Record<string, CheckMeta> {
	const meta: Record<string, CheckMeta> = {
		...buildGenericCheckMeta(),
		...unregistered,
	};
	for (const [id, annotations] of Object.entries(overlay)) {
		const base = meta[id];
		if (!base) {
			throw new Error(
				`ANNOTATION_OVERLAY names unknown check id "${id}" — it is neither registered in CHECK_REGISTRY nor listed in UNREGISTERED_CHECK_META.`,
			);
		}
		meta[id] = { ...base, ...annotations };
	}
	return meta;
}

/** Public API — consumed by doc generation and re-exported from check-metadata.ts. */
export const GENERIC_CHECK_META: Record<string, CheckMeta> = composeGenericCheckMeta();

/** Exported for the companion test only — the two hand-written overlays. */
export const GENERIC_CHECK_META_OVERLAYS = {
	annotations: ANNOTATION_OVERLAY,
	unregistered: UNREGISTERED_CHECK_META,
} as const;
