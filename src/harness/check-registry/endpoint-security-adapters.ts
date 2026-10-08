// ===========================================
// Endpoint-security adapters — registry call-site shim
// ===========================================
// The five Phase B endpoint-security detectors take a richer arg list than
// the standard `(content, filePath) => InlineMatch[]` registry shape:
//
//   (file, content, endpoints, config[, sanitizers]) → DetectorFinding[]
//
// Per pass-2 plan ("Adapter-shape decision: at-registry-call-site"), this
// module is the closure layer that bridges them — `endpoint-security.ts`
// itself stays a pure detector module (no I/O, no daemon state). The
// adapters here resolve project root from `filePath`, lazily build +
// memoize the per-project state, run the detector, run the Phase C/D/E
// annotation pipeline (reachability → sibling expansion → scaffolds),
// and convert `DetectorFinding[]` to the InlineMatch[] shape the registry
// expects.
//
// Memoization is keyed by project root so cross-repo edits (multi-project
// workspaces) each get their own cached state. RouteMap is incremental —
// `extractEndpointsForFile(file, content)` re-scans only the single file
// against the cached map, matching the daemon's PostToolUse pattern.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import {
	checkEndpointAuthMissing,
	checkEndpointIdorShape,
	checkEndpointMassAssignment,
	checkEndpointMissingTenantFilter,
	checkEndpointSsrfShape,
	type DetectorFinding,
} from "../checks/endpoint-security.js";
import { ProjectGraph } from "../project-graph.js";
import { annotateReachability, buildHttpHandlerEntryPoints } from "../reachability-annotator.js";
import { RouteMap } from "../route-map.js";
import { load as loadSanitizers, type SanitizerRegistry } from "../sanitizer-registry.js";
import { attachScaffolds } from "../scaffold-fuzz.js";
import { load as loadSecurityConfig, type SecurityConfig } from "../security-config.js";
import { expandEndpointDetectorSiblings } from "../sibling-expansion.js";
import type { Endpoint } from "../types/session.js";
import type { InlineMatch } from "./types.js";

/** Per-project cache for the four pieces of loaded state. The cache is
 * keyed by absolute project root and never invalidates within a process —
 * RouteMap is incremental (one file per call), Config/Sanitizers are cheap
 * JSON reads, and ProjectGraph maintains its own incremental update path.
 * The daemon hot-reload re-imports this module per SIGHUP if the user
 * touches `.interlinked/*.json`. */
interface ProjectState {
	routeMap: RouteMap;
	config: SecurityConfig;
	sanitizers: SanitizerRegistry;
	/** Used by Phase C reachability annotation. Initialized lazily on first
	 * adapter call per project; init failures are non-fatal — the graph stays
	 * empty and reachability falls back to `reachable: false`, the annotation
	 * still appears but the entry-point list shows what was considered. */
	projectGraph: ProjectGraph;
}

const PROJECT_STATE_CACHE = new Map<string, ProjectState>();

/** Walk up from `filePath` looking for `package.json` / `pyproject.toml`.
 *  Falls back to `process.cwd()` when no marker is found — that matches
 *  the daemon's view for files outside any package (e.g. ad-hoc tmp). */
function findProjectRootFromFile(filePath: string): string {
	let dir = dirname(filePath);
	for (let i = 0; i < 8; i += 1) {
		if (
			existsSync(join(dir, "package.json")) ||
			existsSync(join(dir, "pyproject.toml")) ||
			existsSync(join(dir, ".git"))
		) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return process.cwd();
}

/** Lazily build (and cache) all four pieces of per-project state. */
function getProjectState(filePath: string): ProjectState {
	const projectRoot = findProjectRootFromFile(filePath);
	let state = PROJECT_STATE_CACHE.get(projectRoot);
	if (!state) {
		const projectGraph = new ProjectGraph(projectRoot);
		state = {
			routeMap: new RouteMap(projectRoot),
			config: loadSecurityConfig(projectRoot),
			sanitizers: loadSanitizers(projectRoot),
			projectGraph,
		};
		PROJECT_STATE_CACHE.set(projectRoot, state);
	}
	return state;
}

/** Convert detector findings to the `InlineMatch[]` shape the registry
 * builder consumes. `formatQualityWarnings` later wraps the `text` field
 * into the `[interlinked:<id>] [heuristic] <text>` line shown to agents. */
function findingsToMatches(findings: DetectorFinding[]): InlineMatch[] {
	return findings.map((f) => ({
		line: f.line,
		text: f.message,
	}));
}

/** Resolve endpoints for the given file via the per-project RouteMap.
 * The route-map adapters call `readFileSync` when `content` is omitted —
 * we pass `content` explicitly so the detector sees the agent's in-memory
 * edit, not the on-disk previous version. */
function endpointsFor(
	filePath: string,
	content: string,
	state: ProjectState,
): ReturnType<RouteMap["extractEndpointsForFile"]> {
	return state.routeMap.extractEndpointsForFile(filePath, content);
}

/** Per-detector closure captured by `runEndpointAdapter`. The closure binds
 * the per-detector argument list (only SSRF needs the sanitizer registry)
 * so the sibling-expansion pass can re-run the detector on the same file
 * without each adapter rebinding the signature. */
type BoundDetector = (file: string, content: string, endpoints: Endpoint[]) => DetectorFinding[];

/** Input to {@link applyAnnotations}. Collapsed into one shape so the
 * function stays at one parameter — easier to pass through layers without
 * positional-arg confusion. */
interface AnnotationContext {
	findings: DetectorFinding[];
	state: ProjectState;
	endpoints: Endpoint[];
	detector: BoundDetector;
}

/** Apply the C → D → E annotation chain. Each step is pure (returns a new
 * findings array) and skips itself on empty input. Order matters:
 *   1. Reachability tag lands first so each finding carries it before
 *      sibling-bundling concatenates further suffixes.
 *   2. Sibling expansion appends "same shape on N siblings" to the lead
 *      finding of each (check_id, file) group.
 *   3. Scaffold attachment appends the fenced property-test block last
 *      so the code-block fence is the final thing in the message. */
function applyAnnotations(ctx: AnnotationContext): DetectorFinding[] {
	if (ctx.findings.length === 0) return ctx.findings;
	// A content-only no-match must not trigger a repository traversal. The graph
	// is needed only to annotate findings that the endpoint detector produced.
	try {
		ctx.state.projectGraph.initialize();
	} catch {
		// Preserve the existing best-effort reachability annotation on I/O failure.
	}

	let result = annotateReachability(ctx.findings, {
		projectGraph: ctx.state.projectGraph,
		entryPoints: buildHttpHandlerEntryPoints(ctx.state.routeMap),
	});

	result = expandEndpointDetectorSiblings(result, {
		rescan: (file, fileContent) => {
			const ep = ctx.state.routeMap.extractEndpointsForFile(file, fileContent);
			return ctx.detector(file, fileContent, ep);
		},
	});

	result = attachScaffolds(result, { endpoints: ctx.endpoints });

	return result;
}

/** Shared adapter body. Each export below binds a detector closure and
 * delegates here, so the four-step pipeline stays in one place rather than
 * being duplicated five times. Errors fail open — `[]` is returned and the
 * pipeline keeps running, same posture as `checkExtraneousDependencies`
 * on a broken package.json. */
function runEndpointAdapter(
	content: string,
	filePath: string,
	bindDetector: (state: ProjectState) => BoundDetector,
): InlineMatch[] {
	try {
		const state = getProjectState(filePath);
		const endpoints = endpointsFor(filePath, content, state);
		if (endpoints.length === 0) return [];
		const detector = bindDetector(state);
		const findings = detector(filePath, content, endpoints);
		const annotated = applyAnnotations({ findings, state, endpoints, detector });
		return findingsToMatches(annotated);
	} catch {
		return [];
	}
}

/** Per-check adapter — registry-shaped `(content, filePath) => InlineMatch[]`.
 * Each adapter binds its detector signature (most share `(file, content,
 * endpoints, config)`; SSRF additionally takes the sanitizer registry) and
 * routes through `runEndpointAdapter` for the full annotation pipeline. */
export function adaptEndpointAuthMissing(content: string, filePath: string): InlineMatch[] {
	return runEndpointAdapter(content, filePath, (state) => (file, fileContent, endpoints) =>
		checkEndpointAuthMissing(file, fileContent, endpoints, state.config),
	);
}

export function adaptEndpointIdorShape(content: string, filePath: string): InlineMatch[] {
	return runEndpointAdapter(content, filePath, (state) => (file, fileContent, endpoints) =>
		checkEndpointIdorShape(file, fileContent, endpoints, state.config),
	);
}

export function adaptEndpointMissingTenantFilter(
	content: string,
	filePath: string,
): InlineMatch[] {
	return runEndpointAdapter(content, filePath, (state) => (file, fileContent, endpoints) =>
		checkEndpointMissingTenantFilter(file, fileContent, endpoints, state.config),
	);
}

export function adaptEndpointSsrfShape(content: string, filePath: string): InlineMatch[] {
	return runEndpointAdapter(content, filePath, (state) => (file, fileContent, endpoints) =>
		checkEndpointSsrfShape(file, fileContent, endpoints, state.config, state.sanitizers),
	);
}

export function adaptEndpointMassAssignment(content: string, filePath: string): InlineMatch[] {
	return runEndpointAdapter(content, filePath, (state) => (file, fileContent, endpoints) =>
		checkEndpointMassAssignment(file, fileContent, endpoints, state.config),
	);
}
