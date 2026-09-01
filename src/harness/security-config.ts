// ===========================================
// Security Config Loader — Phase B
// ===========================================
// Project-extensible JSON config consumed by the five endpoint-security
// detectors in `src/harness/checks/endpoint-security.ts`. File lives at
// `.interlinked/security-config.json` (committed; carved out of the
// `.interlinked/*` gitignore alongside `sanitizers.json` and
// `guard-rules.json`).
//
// Style mirrors `src/harness/sanitizer-registry.ts`:
//   - `load(cwd?)` — main entry; reads + validates + applies defaults
//   - `validate(raw)` — pure function; coerces an `unknown` into the
//     typed `SecurityConfig` shape
//   - `defaultConfig()` — defaults baked in when the file is missing
//   - JSON parse / IO failures fail safe by returning the defaults (the
//     daemon never bricks on a hand-edit typo)
//
// No hot-reload in pass 1; the load is called per check invocation and
// the file I/O cost is negligible vs the detector work itself. Hot-
// reload (mirroring `watchSanitizerFiles`) is a follow-up if the cost
// becomes meaningful.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Per-detector config sub-shapes. Each is a plain record so the file
 * round-trips through JSON.parse / JSON.stringify with no surprises. */
interface AuthMissingConfig {
	exempt_paths: string[];
}
interface IdorShapeConfig {
	auth_context_identifiers: string[];
}
interface MissingTenantFilterConfig {
	tenant_columns: string[];
	exempt_tables: string[];
}
interface SsrfShapeConfig {
	exempt_paths: string[];
}
// Reserved for future tunables — empty in V1. Using a `Record<string,
// never>` rather than `{}` so the type accurately rejects extra keys.
type MassAssignmentConfig = Record<string, never>;

/** Loaded security config — keyed by detector check_id. */
export interface SecurityConfig {
	endpoint_auth_missing: AuthMissingConfig;
	endpoint_idor_shape: IdorShapeConfig;
	endpoint_missing_tenant_filter: MissingTenantFilterConfig;
	endpoint_ssrf_shape: SsrfShapeConfig;
	endpoint_mass_assignment: MassAssignmentConfig;
}

/** Built-in defaults — used when the file is missing, malformed, or
 * when a section is absent. Source: `docs/plans/snug-wobbling-castle.md`. */
export function defaultConfig(): SecurityConfig {
	return {
		endpoint_auth_missing: {
			exempt_paths: [
				"/health",
				"/healthz",
				"/ready",
				"/readyz",
				"/metrics",
				"/oauth/callback",
				"/auth/callback",
				"/api/health",
			],
		},
		endpoint_idor_shape: {
			auth_context_identifiers: [
				"req.user",
				"ctx.user",
				"session.user",
				"current_user",
				"ctx.session.user",
				"request.user",
				"auth.user",
			],
		},
		endpoint_missing_tenant_filter: {
			tenant_columns: ["org_id", "workspace_id", "business_id", "tenant_id"],
			exempt_tables: ["sessions", "audit_log", "platform_settings", "feature_flags"],
		},
		endpoint_ssrf_shape: {
			exempt_paths: [],
		},
		endpoint_mass_assignment: {},
	};
}

/** Coerce a raw JSON-parsed object into a typed `SecurityConfig`. Pure
 * function — no I/O. Unknown keys ignored. Missing sections inherit
 * defaults. Used by `load()` and directly by tests. */
export function validate(raw: unknown): SecurityConfig {
	const out = defaultConfig();
	if (!raw || typeof raw !== "object") return out;
	const r = raw as RawConfig;

	const exemptAuth = readStringArray(r.endpoint_auth_missing, "exempt_paths");
	if (exemptAuth !== null) out.endpoint_auth_missing.exempt_paths = exemptAuth;

	const idorIdents = readStringArray(r.endpoint_idor_shape, "auth_context_identifiers");
	if (idorIdents !== null) out.endpoint_idor_shape.auth_context_identifiers = idorIdents;

	const tenantCols = readStringArray(r.endpoint_missing_tenant_filter, "tenant_columns");
	if (tenantCols !== null) out.endpoint_missing_tenant_filter.tenant_columns = tenantCols;

	const exemptTables = readStringArray(r.endpoint_missing_tenant_filter, "exempt_tables");
	if (exemptTables !== null) out.endpoint_missing_tenant_filter.exempt_tables = exemptTables;

	const exemptSsrf = readStringArray(r.endpoint_ssrf_shape, "exempt_paths");
	if (exemptSsrf !== null) out.endpoint_ssrf_shape.exempt_paths = exemptSsrf;

	// endpoint_mass_assignment has no tunables in V1.

	return out;
}

/** Raw, pre-validation top-level shape. Every section is `unknown` because
 * we don't trust the file. The exact per-section shape is checked at
 * read time by {@link readStringArray}. */
interface RawConfig {
	endpoint_auth_missing?: unknown;
	endpoint_idor_shape?: unknown;
	endpoint_missing_tenant_filter?: unknown;
	endpoint_ssrf_shape?: unknown;
	endpoint_mass_assignment?: unknown;
}

/** Read `rawSection[key]` as a string array. Returns `null` if the
 * section is not an object or the key is not a string array — caller
 * preserves the default in that case. Non-string entries within an array
 * are silently dropped (matches sanitizer-registry's `validateEntry`
 * "drop the bad, keep the good" posture).
 *
 * Indexing through `RawSection` (a typed map from string → unknown) keeps
 * the field unconstrained without falling into the bare-`Record<K, unknown>`
 * shape that the broad-object-types check flags. The actual narrowing
 * happens via the `Array.isArray` + per-element `typeof` predicate. */
type RawSection = { readonly [field: string]: unknown };

function readStringArray(rawSection: unknown, key: string): string[] | null {
	if (!rawSection || typeof rawSection !== "object") return null;
	const section = rawSection as RawSection;
	const arr = section[key];
	if (!Array.isArray(arr)) return null;
	return arr.filter((x): x is string => typeof x === "string");
}

/** Path of the committed config file. */
export function securityConfigPath(cwd: string): string {
	return join(cwd, ".interlinked", "security-config.json");
}

/** Read + JSON-parse the security-config file. Returns null on missing or
 * malformed (caller falls back to defaults). */
function readConfigFile(path: string): unknown | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		// Best-effort: malformed JSON → treat as absent so the daemon doesn't
		// brick on a hand-edit typo. Matches sanitizer-registry behavior.
		return null;
	}
}

/** Public API — main entry point. Loads the config file, validates, and
 * returns the merged config. Returns the built-in defaults if the file is
 * missing or malformed. */
export function load(cwd: string = process.cwd()): SecurityConfig {
	const raw = readConfigFile(securityConfigPath(cwd));
	if (raw === null) return defaultConfig();
	return validate(raw);
}
