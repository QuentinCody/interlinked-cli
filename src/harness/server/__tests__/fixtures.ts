import { vi } from "vitest";
import { makeGuardRules, makeQualityCheck } from "../../evaluator/__tests__/fixtures.js";
import { getDefaultConfig } from "../../rules-loader.js";
import { nonNull } from "../../../lib/non-null.js";
import type { GuardRulesConfig, QualityCheckConfig } from "../../types.js";
import type { ServerRuntime } from "../runtime-context.js";
import type { PerFileCheckCtx } from "../post-tool-file-checks.js";
import type { EventLoopDeps } from "../../server-event-loop.js";

// Use real in-memory managers even when a test replaces their module exports.
const { CohortManager } = await vi.importActual<typeof import("../../cohort.js")>("../../cohort.js");
const { SessionTracker } = await vi.importActual<typeof import("../../session-state.js")>("../../session-state.js");
const { ReservationManager } = await vi.importActual<typeof import("../../reservations.js")>("../../reservations.js");
const { ErrorHistory } = await vi.importActual<typeof import("../../error-history.js")>("../../error-history.js");
const { RouteMap } = await vi.importActual<typeof import("../../route-map.js")>("../../route-map.js");
const { AsyncFindingQueue } = await vi.importActual<typeof import("../../async-finding-queue.js")>("../../async-finding-queue.js");
const { FileContentCache } = await vi.importActual<typeof import("../../grep-accelerator.js")>("../../grep-accelerator.js");
const { ProjectWideSweepState } = await vi.importActual<typeof import("../../quality-checks/project-wide.js")>("../../quality-checks/project-wide.js");
const { TrigramIndex } = await vi.importActual<typeof import("../../trigram-index.js")>("../../trigram-index.js");
const { DEFAULT_AUTO_COORDINATION_CONFIG } = await vi.importActual<typeof import("../../auto-coordinate.js")>("../../auto-coordinate.js");
const { createProtocolStatus } = await vi.importActual<typeof import("../protocol-status.js")>("../protocol-status.js");

export function makeTrigramIndex(baseCommit: string, dirty = false) {
	const index = new TrigramIndex([], new Map(), new Set(), baseCommit, "/repo");
	if (dirty) index.updateFile("dirty-fixture.ts", "export const changed = true;");
	return index;
}

type ManagerKey = "cohort" | "sessions" | "reservations" | "errorHistory" | "routeMap" | "asyncFindings" | "projectWideSweepState" | "fileContentCache";
type ValueKey = "learnedRules" | "asyncAnalysis" | "autoCoordConfig";
type RuntimeOverrides = Omit<Partial<ServerRuntime>, ManagerKey | ValueKey> & {
	[K in ManagerKey]?: Partial<ServerRuntime[K]>;
} & {
	[K in ValueKey]?: Partial<ServerRuntime[K]>;
};

type ScannerConfig = NonNullable<GuardRulesConfig["content_scanner"]>;
type RuleOverrides = Omit<Partial<GuardRulesConfig>, "structural_checks" | "error_memory" | "quality_checks" | "project_wide_checks" | "content_scanner" | "verification_stop_checks"> & {
	structural_checks?: Partial<GuardRulesConfig["structural_checks"]>;
	error_memory?: Partial<GuardRulesConfig["error_memory"]>;
	quality_checks?: Record<string, Partial<QualityCheckConfig>>;
	project_wide_checks?: Partial<NonNullable<GuardRulesConfig["project_wide_checks"]>>;
	content_scanner?: Omit<Partial<ScannerConfig>, "scan_points" | "local"> & {
		scan_points?: Partial<ScannerConfig["scan_points"]>;
		local?: Partial<ScannerConfig["local"]>;
	};
	verification_stop_checks?: Partial<NonNullable<GuardRulesConfig["verification_stop_checks"]>>;
};

/** Complete nested configuration while leaving unrelated optional guards inactive. */
export function makeServerRules(overrides: RuleOverrides = {}): GuardRulesConfig {
	const base = makeGuardRules();
	const defaults = getDefaultConfig();
	const { structural_checks, error_memory, quality_checks, project_wide_checks, content_scanner, verification_stop_checks, ...fields } = overrides;
	return {
		...base,
		...fields,
		structural_checks: { ...base.structural_checks, ...structural_checks },
		error_memory: { ...base.error_memory, ...error_memory },
		quality_checks: Object.fromEntries(Object.entries(quality_checks ?? {}).map(([name, config]) => [name, makeQualityCheck(config)])),
		...(project_wide_checks && { project_wide_checks: { ...nonNull(defaults.project_wide_checks), ...project_wide_checks } }),
		...(content_scanner && { content_scanner: { ...nonNull(defaults.content_scanner), ...content_scanner, scan_points: { ...nonNull(defaults.content_scanner).scan_points, ...content_scanner.scan_points }, local: { ...nonNull(defaults.content_scanner).local, ...content_scanner.local } } }),
		...(verification_stop_checks && { verification_stop_checks: { ...nonNull(defaults.verification_stop_checks), ...verification_stop_checks } }),
	};
}

export function makeServerRuntime(overrides: RuntimeOverrides = {}): ServerRuntime {
	const { cohort, sessions, reservations, errorHistory, routeMap, asyncFindings, projectWideSweepState, fileContentCache, learnedRules, asyncAnalysis, autoCoordConfig, ...fields } = overrides;
	const cwd = overrides.cwd ?? "/repo";
	const interlinkedDir = `${cwd}/.interlinked`;
	const rules = overrides.rules ?? makeGuardRules();
	return {
		cwd,
		interlinkedDir,
		rules,
		cohort: cohort instanceof CohortManager ? cohort : Object.assign(new CohortManager(), cohort),
		sessions: sessions instanceof SessionTracker ? sessions : Object.assign(new SessionTracker(), sessions),
		reservations: reservations instanceof ReservationManager ? reservations : Object.assign(new ReservationManager(), reservations),
		errorHistory: errorHistory instanceof ErrorHistory ? errorHistory : Object.assign(new ErrorHistory(interlinkedDir, rules.error_memory), errorHistory),
		routeMap: routeMap instanceof RouteMap ? routeMap : Object.assign(new RouteMap(cwd), routeMap),
		serverBridge: null,
		asyncFindings: asyncFindings instanceof AsyncFindingQueue ? asyncFindings : Object.assign(new AsyncFindingQueue(), asyncFindings),
		learnedRules: { rules: [], has: vi.fn(() => false), observe: vi.fn(() => null), save: vi.fn(), load: vi.fn(), ...learnedRules },
		asyncAnalysis: { inProgress: false, submit: vi.fn(), consume: vi.fn(() => []), drain: vi.fn(async () => {}), ...asyncAnalysis },
		projectWideSweepState: projectWideSweepState instanceof ProjectWideSweepState ? projectWideSweepState : Object.assign(new ProjectWideSweepState(), projectWideSweepState),
		contentScanner: undefined,
		compiledAllowlist: [],
		classifierSessions: new Map(),
		autoCoordStates: new Map(),
		autoCoordConfig: { ...DEFAULT_AUTO_COORDINATION_CONFIG, ...autoCoordConfig },
		indexWarningSent: new Set(),
		preEditBaselines: new Map(),
		trigramIndex: null,
		fileContentCache: fileContentCache instanceof FileContentCache ? fileContentCache : Object.assign(new FileContentCache(), fileContentCache),
		structureGraph: null,
		structureConfigCache: null,
		specLedger: null,
		filePriorityMap: new Map(),
		graphCache: new Map(),
		log: vi.fn(),
		logAlways: vi.fn(),
		writeClassifierStatus: vi.fn(),
		writeReviewPendingMarker: vi.fn(),
		...fields,
	};
}

export function makePerFileCheckCtx(overrides: Partial<PerFileCheckCtx> = {}): PerFileCheckCtx {
	return { postStartMs: 0, allCheckResults: [], checksRan: [], postToolMetrics: [], markPhase: vi.fn(), projectWideSweepFired: false, recurrenceCursor: 0, ...overrides };
}

export function makeEventLoopDeps(overrides: Partial<EventLoopDeps> = {}): EventLoopDeps {
	return {
		ctx: makeServerRuntime(),
		protocolStatus: createProtocolStatus({ protocol: "dual", rawSocketPath: "/repo/raw.sock", framedSocketPath: "/repo/framed.sock", framedSessionId: "session" }),
		protocolStatusPath: "/repo/.interlinked/harness-protocol.json",
		resetIdleTimer: vi.fn(),
		syncRuntimeIn: vi.fn(),
		syncRuntimeOut: vi.fn(),
		writeCollectionRecord: vi.fn(),
		writeLifecycleActivityRecord: vi.fn(),
		...overrides,
	};
}
