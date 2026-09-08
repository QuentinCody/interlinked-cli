// ===========================================
// Harness server runtime context
// ===========================================
// `processEvent` and its extracted Pre/Post/lifecycle pipelines need access
// to ~30 pieces of module-level daemon state (rule config, the session
// tracker, the reservation manager, lazily-built project graphs, …).
//
// Rather than thread 30 parameters, server.ts builds ONE `ServerRuntime`
// object at startup and passes it to each pipeline. Fields that server.ts
// reassigns at runtime (`rules` on hot-reload, `trigramIndex` after the
// background load, `compiledAllowlist` on rules-reload, the three
// `structure*`/`filePriorityMap` caches) are MUTABLE on this object — the
// watcher/SIGHUP handlers write `ctx.rules = …` and the pipelines read the
// current value, so live state can't drift from what the handlers see.
//
// Extracted verbatim from the monolithic server.ts; no behavior change.

import type { JsonObject } from "../../lib/json-types.js";
import type { AsyncAnalysisManager } from "../async-analysis.js";
import type { AsyncFindingQueue } from "../async-finding-queue.js";
import type { AutoCoordinationConfig, AutoCoordinationState } from "../auto-coordinate.js";
import { createAutoCoordinationState } from "../auto-coordinate.js";
import type { CohortManager } from "../cohort.js";
import type { CompiledEntry } from "../content-scanner/allowlist.js";
import type { ContentScanner } from "../content-scanner/types.js";
import type { ErrorHistory } from "../error-history.js";
import type { FilePriority } from "../file-priority.js";
import type { FileContentCache } from "../grep-accelerator.js";
import type { LearnedRulesStore } from "../learned-rules.js";
import type { ClassifierSessionState } from "../policy-classifier.js";
import { ProjectGraph } from "../project-graph.js";
import { captureProjectGraph } from "../data-capture-graph.js";
import { findProjectRoot, type ProjectWideSweepState } from "../quality-checks.js";
import type { ReservationManager } from "../reservations.js";
import type { RouteMap } from "../route-map.js";
import type { ServerBridge } from "../server-bridge.js";
import type { SessionTracker } from "../session-state.js";
import type { ArtifactGraph } from "../structure/artifact-graph.js";
import type { StructureConfig } from "../structure/types.js";
import type { TrigramIndex } from "../trigram-index.js";
import type { GuardRulesConfig, PreEditBaseline } from "../types.js";

/** All daemon-scoped mutable state, bundled so extracted pipelines can
 *  receive a single `ctx` parameter instead of ~30 closures. */
export interface ServerRuntime {
	/** Repo root the daemon was launched for. */
	readonly cwd: string;
	/** `<cwd>/.interlinked`. */
	readonly interlinkedDir: string;
	hookCoverage?: ReturnType<typeof import("../hook-filesystem-watch.js").startHookFilesystemWatch>;
	hookCoverageUnavailable?: string;

	/** Active rule config. Reassigned by the rules watcher + SIGHUP. */
	rules: GuardRulesConfig;
	readonly cohort: CohortManager;
	readonly sessions: SessionTracker;
	readonly reservations: ReservationManager;
	readonly errorHistory: ErrorHistory;
	readonly routeMap: RouteMap;
	readonly serverBridge: Pick<ServerBridge, "reportGuardEvent" | "fetchCoordinationState"> | null;

	readonly asyncFindings: AsyncFindingQueue;
	readonly learnedRules: LearnedRulesStore;
	readonly asyncAnalysis: AsyncAnalysisManager;
	readonly projectWideSweepState: ProjectWideSweepState;

	/** ML content scanner — undefined when disabled/misconfigured. */
	readonly contentScanner: ContentScanner | undefined;
	/** Recompiled by the rules watcher on every reload. */
	compiledAllowlist: CompiledEntry[];

	/** Per-session classifier state (call count, consecutive failures). */
	readonly classifierSessions: Map<string, ClassifierSessionState>;
	/** Per-session auto-coordination state. */
	readonly autoCoordStates: Map<string, AutoCoordinationState>;
	/** Merged auto-coordination config — mutated in place on rules reload. */
	readonly autoCoordConfig: AutoCoordinationConfig;
	/** Sessions that already saw the once-per-session index-status warning. */
	readonly indexWarningSent: Set<string>;
	/** Diff-aware pre-edit baselines, keyed by absolute file path. */
	readonly preEditBaselines: Map<string, PreEditBaseline>;

	/** Trigram search index — null until the background load finishes. */
	trigramIndex: TrigramIndex | null;
	readonly fileContentCache: FileContentCache;

	/** Cached artifact graph — persists across PostToolUse calls. */
	structureGraph: ArtifactGraph | null;
	structureConfigCache: StructureConfig | null;
	/** Cross-file spec fact ledger — lazily built on the first markdown edit,
	 *  then kept fresh per edit (docs/design/spec-audit-runtime-checks.md §3.2). */
	specLedger?: import("../spec/ledger.js").SpecLedger | null;
	/** Recency-weighted per-file priority map (Mythos Phase 4). */
	filePriorityMap: Map<string, FilePriority>;

	/** Lazily-created `ProjectGraph` per project root. */
	readonly graphCache: Map<string, ProjectGraph>;

	/** Verbose-gated logger. */
	readonly log: (msg: string) => void;
	/** Always-on logger. */
	readonly logAlways: (msg: string) => void;

	/** Persist the one-line classifier status for the statusline script. */
	readonly writeClassifierStatus: (status: string) => void;
	/** Persist the pending-review count for the statusline script. */
	readonly writeReviewPendingMarker: (count: number) => void;
}

/**
 * Resolve (and lazily build + cache) the `ProjectGraph` for the project the
 * given file belongs to. Supports cross-repo edits: a file under another
 * repo gets that repo's graph, not the daemon's CWD graph.
 */
export function getGraphForFile(ctx: ServerRuntime, filePath: string): ProjectGraph {
	const projectRoot = findProjectRoot(filePath, ctx.cwd) || ctx.cwd;
	let g = ctx.graphCache.get(projectRoot);
	if (!g) {
		g = new ProjectGraph(projectRoot);
		try {
			g.initialize();
			ctx.log(`Project graph initialized for ${projectRoot}: ${g.fileCount} files`);
		} catch (err) {
			ctx.log(`Project graph init failed for ${projectRoot} (non-fatal): ${err}`);
		}
		ctx.graphCache.set(projectRoot, g);
	}
	captureProjectGraph(ctx.cwd, projectRoot, g);
	return g;
}

/** Get (or lazily create) the auto-coordination state for a session. */
export function getAutoCoordState(
	ctx: ServerRuntime,
	sessionId: string,
): AutoCoordinationState {
	let state = ctx.autoCoordStates.get(sessionId);
	if (!state) {
		state = createAutoCoordinationState();
		ctx.autoCoordStates.set(sessionId, state);
	}
	return state;
}

/** Build a one-line summary of the tool being invoked — used in guard-event
 *  reports and log lines. Capped at 200 chars for commands/URLs. */
export function summarizeToolInput(event: {
	tool_name?: string | undefined;
	tool_input?: JsonObject | undefined;
}): string {
	if (!event.tool_input) return event.tool_name || "";
	const input = event.tool_input;
	if (input.command) return String(input.command).slice(0, 200);
	if (input.file_path) return String(input.file_path);
	if (input.url) return String(input.url).slice(0, 200);
	return event.tool_name || "";
}
