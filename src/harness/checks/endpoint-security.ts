// ===========================================
// Endpoint security detectors — Phase B
// ===========================================
// Five PostToolUse warning detectors that consume the Phase A3 `Endpoint`
// shape and flag the high-severity bug classes Ramp's agent-swarm scan
// surfaced (IDOR, missing auth, tenant-isolation gaps, SSRF, mass
// assignment). Each detector is a pure function:
//
//   (file, content, endpoints, config[, sanitizers]) → DetectorFinding[]
//
// No I/O, no daemon state. Reachability annotation (Phase C),
// recurrence aggregation (Phase D), and property-test scaffolds
// (Phase E) wrap these detectors externally — this module's contract is
// the deterministic per-edit shape match only.
//
// Pass 1 (this commit) is detectors + tests only. Registry wiring,
// metadata, parity-test updates, and verify-command plumbing land in
// pass 2 of the plan.

import { nonNull } from "../../lib/non-null.js";
import { isSanitized, type SanitizerRegistry } from "../sanitizer-registry.js";
import type { SecurityConfig } from "../security-config.js";
import type { Endpoint } from "../types/session.js";
import { isEndpointSecurityExemptFile } from "./endpoint-security-exemptions.js";
import {
	collectWhereClauses,
	queryIsDynamic,
	referencesExemptTable,
} from "./endpoint-security-tenant-helpers.js";

// Family-level FP gate (2026-07 noise review): test files, fixture trees,
// and vendored code are not deployable endpoints — every detector below
// early-returns on them. Rationale + predicate live in
// `endpoint-security-exemptions.ts`; re-exported here so the family's
// public surface stays on this module.
export { isEndpointSecurityExemptFile } from "./endpoint-security-exemptions.js";

/** A single detector finding. Mirrors the shape `verify` consumes; pass
 * 2 will wrap it in the canonical registry envelope. */
export interface DetectorFinding {
	check_id: string;
	file: string;
	line: number;
	message: string;
	snippet?: string;
	endpoint_path?: string;
	endpoint_method?: string;
}

// ===========================================
// Handler-body scope extraction (shared)
// ===========================================
//
// The endpoint extractor gives us the route-registration line. To inspect
// the handler body we need to delimit "where does the handler end?". V1
// uses a deliberately simple rule: from the route line forward to whichever
// of these comes first:
//   - the next route-registration line in the same file, OR
//   - 200 lines forward (cap), OR
//   - EOF.
//
// That's coarse — a real scope-aware walker would need an AST — but the
// FP/FN trade is acceptable for the shape-match detectors we ship in V1.
// The cap is documented here as required by the spec.

const HANDLER_SCOPE_LINE_CAP = 200;

/** Sub-array of lines making up the handler body for `endpoint`. Indexes
 * preserved so detectors can compute absolute line numbers from a hit. */
interface HandlerScope {
	startLine: number; // 1-indexed, inclusive
	endLine: number; // 1-indexed, exclusive
	bodyText: string;
}

function getHandlerScope(
	content: string,
	endpoint: Endpoint,
	allEndpoints: Endpoint[],
): HandlerScope {
	const start = endpoint.line ?? 1;
	const lines = content.split("\n");
	// Find the next-endpoint line in the same file (or far past EOF).
	let nextEndpointLine = Number.POSITIVE_INFINITY;
	for (const other of allEndpoints) {
		if (other === endpoint) continue;
		if (other.file !== endpoint.file) continue;
		if (other.line === undefined) continue;
		if (other.line > start && other.line < nextEndpointLine) {
			nextEndpointLine = other.line;
		}
	}
	const cap = Math.min(start + HANDLER_SCOPE_LINE_CAP, lines.length + 1);
	const end = Math.min(nextEndpointLine, cap);
	const sliced = lines.slice(start - 1, end - 1);
	return {
		startLine: start,
		endLine: end,
		bodyText: sliced.join("\n"),
	};
}

// ===========================================
// B1: endpoint_auth_missing
// ===========================================

const SAFE_METHODS = new Set(["OPTIONS", "HEAD"]);
const AUTH_MIDDLEWARE_RE =
	/auth|authn|authorize|requireUser|requireAuth|verifyToken|sessionUser|currentUser/i;

/**
 * Fires when an endpoint's `auth_chain` is empty AND no recognized auth
 * middleware appears at the router-mount level in the same file.
 *
 * The route-extractor populates `auth_chain` already; this check is a
 * defense-in-depth second pass for the cases the extractor missed (e.g.
 * `app.use(...)` mounted via a different receiver-name).
 */
export function checkEndpointAuthMissing(
	file: string,
	content: string,
	endpoints: Endpoint[],
	config: SecurityConfig,
): DetectorFinding[] {
	if (isEndpointSecurityExemptFile(file)) return [];
	const findings: DetectorFinding[] = [];
	const exemptPaths = new Set(config.endpoint_auth_missing.exempt_paths);
	const hasMountLevelAuth = scanForMountLevelAuth(content);

	for (const endpoint of endpoints) {
		if (SAFE_METHODS.has(endpoint.method.toUpperCase())) continue;
		if (endpoint.auth_chain.length > 0) continue;
		if (exemptPaths.has(endpoint.path)) continue;
		if (hasMountLevelAuth) continue;
		findings.push({
			check_id: "endpoint_auth_missing",
			file,
			line: endpoint.line ?? 1,
			message: `Endpoint ${endpoint.method} ${endpoint.path} has no recognized auth middleware. Add an auth check (e.g. requireAuth, currentUser) or add the path to .interlinked/security-config.json#endpoint_auth_missing.exempt_paths.`,
			endpoint_path: endpoint.path,
			endpoint_method: endpoint.method,
		});
	}
	return findings;
}

/** Scan top-level `app.use(<authMiddleware>)` / `router.use(...)` for an
 * identifier that names an auth function. Same regex as auth-chain.ts —
 * this is just the in-file backstop for chains the per-endpoint detector
 * couldn't attribute. */
function scanForMountLevelAuth(content: string): boolean {
	const useRe =
		/\b(?:[A-Za-z_$][\w$]*)\.use\s*\(\s*(?:["'`][^"'`]*["'`]\s*,\s*)?([A-Za-z_$][\w$]*)/g;
	useRe.lastIndex = 0;
	for (let m = useRe.exec(content); m !== null; m = useRe.exec(content)) {
		if (AUTH_MIDDLEWARE_RE.test(nonNull(m[1]))) return true;
	}
	return false;
}

// ===========================================
// B2: endpoint_idor_shape
// ===========================================
//
// Conditions (all must hold):
//   1. Endpoint has a path-param (declared_params[i].source === "path")
//   2. Handler body reads that param (TS: req.params.<name>,
//      c.req.param("<name>"), params.<name>; Python: function arg)
//   3. Handler body has a DB-style call using the param as a key
//      (Prisma findUnique({where: {id: <param>}}), findOne, raw SQL
//      WHERE id = ?, ORM find_by_id)
//   4. No predicate in the query references a config.auth_context_identifiers value
//
// Simplification vs spec: condition (3) is matched coarsely — any DB-shaped
// call in the handler scope passes. Pinning the exact-param-as-key match
// would need a tokenizer; the current "DB call AND param read AND no auth
// context" is conservative enough for V1.

const DB_KEY_CALL_RE = /(findUnique|findOne|findById|find_by_id|delete|update)\s*\(/;
const RAW_SQL_WHERE_RE = /WHERE\s+\w+\s*=/i;

export function checkEndpointIdorShape(
	file: string,
	content: string,
	endpoints: Endpoint[],
	config: SecurityConfig,
): DetectorFinding[] {
	if (isEndpointSecurityExemptFile(file)) return [];
	const findings: DetectorFinding[] = [];
	const authIdents = config.endpoint_idor_shape.auth_context_identifiers;

	for (const endpoint of endpoints) {
		const pathParams = endpoint.declared_params.filter((p) => p.source === "path");
		if (pathParams.length === 0) continue;

		const scope = getHandlerScope(content, endpoint, endpoints);
		const body = scope.bodyText;

		// (2) Handler body reads at least one of the path params.
		const readParam = pathParams.some((p) => paramIsRead(body, p.name, endpoint.framework));
		if (!readParam) continue;

		// (3) DB-style call in handler scope.
		const hasDbCall = DB_KEY_CALL_RE.test(body) || RAW_SQL_WHERE_RE.test(body);
		if (!hasDbCall) continue;

		// (4) No auth-context identifier in the body.
		const authContextPresent = authIdents.some((ident) => body.includes(ident));
		if (authContextPresent) continue;

		findings.push({
			check_id: "endpoint_idor_shape",
			file,
			line: endpoint.line ?? 1,
			message: `Endpoint ${endpoint.method} ${endpoint.path} reads a path param and uses it as a DB key without checking ownership against an auth context (${authIdents.slice(0, 3).join(", ")}…). Add an authorization predicate to the query.`,
			endpoint_path: endpoint.path,
			endpoint_method: endpoint.method,
		});
	}
	return findings;
}

/** True if `name` is read in `body` via any framework-typical access shape. */
function paramIsRead(body: string, name: string, framework: Endpoint["framework"]): boolean {
	const safe = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (framework === "fastapi") {
		// Python: function arg referenced bare in the body — match `<name>` as
		// a stand-alone identifier (not inside strings, but the cheap regex
		// trade is fine for V1).
		return new RegExp(String.raw`(?<![\w$])${safe}(?![\w$])`).test(body);
	}
	// TS / JS: req.params.<name>, c.req.param("<name>"), params.<name>
	const patterns = [
		new RegExp(String.raw`req\.params\.${safe}\b`),
		new RegExp(String.raw`c\.req\.param\(\s*['"\`]${safe}['"\`]\s*\)`),
		new RegExp(String.raw`(?<![\w$])params\.${safe}\b`),
	];
	return patterns.some((re) => re.test(body));
}

// ===========================================
// B3: endpoint_missing_tenant_filter
// ===========================================
//
// Fires when a DB query in handler scope omits ALL configured tenant
// columns. Conservative bias: if WHERE is dynamically built (spread into
// a builder, params object passed in, etc.), DON'T fire — FN > FP.
//
// V1 inspects three shapes:
//   - Prisma-ish `where: { ... }` literal
//   - Raw SQL string containing `WHERE`
//   - ORM `.filter(...)` / `.where(...)` chained method
//
// Each inspection happens line-locally inside the handler scope. A single
// finding per endpoint at most (we collapse multiple DB calls into one
// warning to avoid amplification).

export function checkEndpointMissingTenantFilter(
	file: string,
	content: string,
	endpoints: Endpoint[],
	config: SecurityConfig,
): DetectorFinding[] {
	if (isEndpointSecurityExemptFile(file)) return [];
	const findings: DetectorFinding[] = [];
	const tenantCols = config.endpoint_missing_tenant_filter.tenant_columns;
	const exemptTables = new Set(
		config.endpoint_missing_tenant_filter.exempt_tables.map((t) => t.toLowerCase()),
	);

	for (const endpoint of endpoints) {
		const scope = getHandlerScope(content, endpoint, endpoints);
		const body = scope.bodyText;
		if (
			!/(findMany|findFirst|findUnique|findAll|update|deleteMany|delete|count|\.query\(|SELECT\s+|UPDATE\s+|DELETE\s+|\.filter\(|\.where\()/i.test(
				body,
			)
		) {
			continue;
		}
		if (referencesExemptTable(body, exemptTables)) continue;
		if (queryIsDynamic(body)) continue;

		const clauses = collectWhereClauses(body);
		if (clauses.length === 0) continue;
		// Fire when EVERY clause omits ALL tenant columns. (If at least one
		// clause already includes a tenant col, the endpoint is doing the
		// right thing somewhere — don't muddy the waters with a finding.)
		const everyClauseMissingTenant = clauses.every(
			(clause) => !tenantCols.some((col) => clause.includes(col)),
		);
		if (!everyClauseMissingTenant) continue;

		findings.push({
			check_id: "endpoint_missing_tenant_filter",
			file,
			line: endpoint.line ?? 1,
			message: `Endpoint ${endpoint.method} ${endpoint.path} runs a DB query that does not filter by any tenant column (${tenantCols.join(", ")}). Add a tenant predicate or mark the table exempt in .interlinked/security-config.json#endpoint_missing_tenant_filter.exempt_tables.`,
			endpoint_path: endpoint.path,
			endpoint_method: endpoint.method,
		});
	}
	return findings;
}

// ===========================================
// B4: endpoint_ssrf_shape
// ===========================================
//
// Conditions (all must hold):
//   1. Handler param is URL-shaped — name matches /url|redirect|webhook|
//      callback|target|endpoint/i OR declared schema_name is "URL" /
//      "HttpUrl" / "AnyUrl".
//   2. That value flows to fetch / axios / request / urllib / httpx /
//      http.client / node:http / node:https.
//   3. Value does NOT pass through any sanitizer in the A1 `url` bucket.
//
// V1: single-frame intra-function only. Multi-frame taint is Phase C+.

const URL_PARAM_NAME_RE = /url|redirect|webhook|callback|target|endpoint/i;
const URL_SCHEMA_NAMES = new Set(["URL", "HttpUrl", "AnyUrl"]);
const HTTP_CLIENT_RE =
	/\b(?:fetch|axios|request|urllib\.request\.urlopen|urllib3\.PoolManager|httpx|http\.client|https?\.request)\b\s*[\.(]/;

export function checkEndpointSsrfShape(
	file: string,
	content: string,
	endpoints: Endpoint[],
	config: SecurityConfig,
	sanitizers: SanitizerRegistry,
): DetectorFinding[] {
	if (isEndpointSecurityExemptFile(file)) return [];
	const findings: DetectorFinding[] = [];
	const exemptPaths = new Set(config.endpoint_ssrf_shape.exempt_paths);

	for (const endpoint of endpoints) {
		if (exemptPaths.has(endpoint.path)) continue;
		const scope = getHandlerScope(content, endpoint, endpoints);
		const body = scope.bodyText;

		// (1) Has at least one URL-shaped param or declared schema.
		const urlParamNames = collectUrlParamNames(endpoint, body);
		if (urlParamNames.length === 0) continue;

		// (2) Body uses an HTTP client.
		if (!HTTP_CLIENT_RE.test(body)) continue;

		// (3) Body does not pass any URL through a registered url-bucket
		// sanitizer. We test the entire body — the V1 single-frame
		// intra-function flow check.
		if (isSanitized(sanitizers, "url", body)) continue;

		findings.push({
			check_id: "endpoint_ssrf_shape",
			file,
			line: endpoint.line ?? 1,
			message: `Endpoint ${endpoint.method} ${endpoint.path} reads a URL-shaped value (${urlParamNames.join(", ")}) and passes it to an HTTP client without an allow-list check. Validate the URL host against an allow-list before issuing the request.`,
			endpoint_path: endpoint.path,
			endpoint_method: endpoint.method,
		});
	}
	return findings;
}

// Python signature args appear in `body` because handler scope starts at
// the decorator and continues into the function body — match the
// `def name(arg1, arg2):` signature line and pick out URL-shaped names.
function collectPythonDefUrlParamNames(body: string): string[] {
	const found: string[] = [];
	const pyDefRe = /^\s*(?:async\s+)?def\s+\w+\s*\(([^)]*)\)/m;
	const pyDef = pyDefRe.exec(body);
	if (!pyDef) return found;
	const args = nonNull(pyDef[1]).split(",");
	for (const arg of args) {
		const name = nonNull(nonNull(arg.split(":")[0]).split("=")[0]).trim();
		if (name && URL_PARAM_NAME_RE.test(name)) found.push(name);
	}
	return found;
}

/** Collect URL-shaped param names from both the declared params and the
 * handler body. Body-based detection is needed because Express/Hono
 * extractors only emit path params; query/body URL fields live in the
 * handler body itself. */
function collectUrlParamNames(endpoint: Endpoint, body: string): string[] {
	const names = new Set<string>();
	for (const p of endpoint.declared_params) {
		if (URL_PARAM_NAME_RE.test(p.name)) names.add(p.name);
		if (p.schema_name && URL_SCHEMA_NAMES.has(p.schema_name)) names.add(p.name);
	}
	// req.body.<x> / req.query.<x> / c.req.query("<x>") shapes.
	const re = /(?:req\.(?:body|query|params)\.|c\.req\.(?:query|param)\(\s*['"\`])([A-Za-z_][\w]*)/g;
	for (let m = re.exec(body); m !== null; m = re.exec(body)) {
		if (URL_PARAM_NAME_RE.test(nonNull(m[1]))) names.add(nonNull(m[1]));
	}
	for (const name of collectPythonDefUrlParamNames(body)) names.add(name);
	return Array.from(names);
}

// ===========================================
// B5: endpoint_mass_assignment
// ===========================================
//
// Fires when a handler spreads request body into a model create/update
// without an explicit allowlist. Hits:
//   - prisma.X.create({ data: req.body })
//   - { ...req.body } as the value of a `data:` field
//   - Object.assign(target, req.body)
//   - db.X.insert(req.body)
//   - FastAPI Model(**request.json()) / Model(**payload)
//
// Negatives that must NOT fire (each tested in endpoint-security.test.ts):
//   - body run through z.parse() / safeParse() / .validate() first
//   - explicit destructure then rebuild ({ name, email } = req.body; data: { name, email })
//   - pick(req.body, [...]) filter
//
// V1 strategy: search the handler body for any of the positive shapes,
// then negate when one of the sanitizer-style patterns appears earlier
// in the body.

const SPREAD_BODY_RE =
	/(?:data\s*:\s*\{\s*\.\.\.\s*(?:req\.body|request\.body|ctx\.req\.json\(\))\b|data\s*:\s*(?:req\.body|request\.body)\b|Object\.assign\s*\([^)]*,\s*(?:req\.body|request\.body)|\.\s*insert\s*\(\s*(?:req\.body|request\.body)\s*\))/;
const PY_KW_SPLAT_RE =
	/\b[A-Z][A-Za-z_]*\s*\(\s*\*\*\s*(?:request\.json\(\)|payload|body|data)\s*\)/;

// Negative-context patterns: if any of these fire BEFORE the positive
// pattern in the body, the body was filtered/validated.
const SANITIZED_BODY_RE =
	/(?:\.parse\s*\(|\.safeParse\s*\(|\bpick\s*\(\s*(?:req\.body|request\.body)|const\s*\{\s*[\w,\s]+\s*\}\s*=\s*(?:req\.body|request\.body)|\.\s*validate\s*\()/;

export function checkEndpointMassAssignment(
	file: string,
	content: string,
	endpoints: Endpoint[],
	_config: SecurityConfig,
): DetectorFinding[] {
	if (isEndpointSecurityExemptFile(file)) return [];
	const findings: DetectorFinding[] = [];

	for (const endpoint of endpoints) {
		const scope = getHandlerScope(content, endpoint, endpoints);
		const body = scope.bodyText;
		const spreadHit = SPREAD_BODY_RE.exec(body);
		const pySplatHit = PY_KW_SPLAT_RE.exec(body);
		const hit = spreadHit ?? pySplatHit;
		if (!hit) continue;

		// Negative-context check: any sanitizer pattern earlier in the body?
		// If yes, treat the body as filtered and skip.
		const sanHit = SANITIZED_BODY_RE.exec(body);
		if (sanHit && sanHit.index < hit.index) continue;

		findings.push({
			check_id: "endpoint_mass_assignment",
			file,
			line: endpoint.line ?? 1,
			message: `Endpoint ${endpoint.method} ${endpoint.path} spreads request body into a model create/update without an explicit field allowlist. Pick fields explicitly or validate with a schema (zod / Pydantic) first.`,
			endpoint_path: endpoint.path,
			endpoint_method: endpoint.method,
		});
	}
	return findings;
}

// ===========================================
// Batch convenience
// ===========================================

/** Run all five endpoint-security detectors and concatenate findings. */
export function runAllEndpointSecurityChecks(
	file: string,
	content: string,
	endpoints: Endpoint[],
	config: SecurityConfig,
	sanitizers: SanitizerRegistry,
): DetectorFinding[] {
	const findings: DetectorFinding[] = [];
	findings.push(...checkEndpointAuthMissing(file, content, endpoints, config));
	findings.push(...checkEndpointIdorShape(file, content, endpoints, config));
	findings.push(...checkEndpointMissingTenantFilter(file, content, endpoints, config));
	findings.push(...checkEndpointSsrfShape(file, content, endpoints, config, sanitizers));
	findings.push(...checkEndpointMassAssignment(file, content, endpoints, config));
	return findings;
}
