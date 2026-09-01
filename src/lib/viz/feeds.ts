// ===========================================
// Viz Feeds — one descriptor per live lens
// ===========================================
// The dashboard has several independent live streams (tool activity, gate
// decisions, ordered test results, mutants). They differ only in WHICH file they
// tail and HOW a line maps to an event, so each is declared as a `VizFeed`
// descriptor and the server hosts them all through one generic SSE path. Adding
// a lens is a descriptor here, not another copy of the plumbing.

import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AgentPresence, AgentRoster } from "./agent-roster.js";
import {
	createActivityTailer,
	createChecksTailer,
	readAppendedLines,
	seedRecentChecks,
	seedRecentEvents,
} from "./event-stream.js";
import { createMutantWatcher, type MutantEvent, readMutantSnapshot } from "./mutation-feed.js";
import { createTestTailer, seedRecentTestEvents } from "./test-events.js";

/** A live stream the dashboard can subscribe to over SSE. */
export interface VizFeed {
	/** HTTP path the browser opens an EventSource against. */
	route: string;
	/** SSE hello comment — visible in devtools, names the stream. */
	hello: string;
	/** Recent backlog replayed to a joining client, oldest first. */
	seed: () => unknown[];
	/** Start delivering new events; the returned handle stops delivery. */
	subscribe: (onEvent: (ev: unknown) => void) => { stop: () => void };
}

/** Backlog size replayed to a joining client. Enough to fill a screen, not a log. */
const SEED_EVENTS = 40;

/** Test-feed backlog. Larger: a run emits a burst, and the lens is about order. */
const SEED_TESTS = 120;

/** Resolved locations of every file the feeds read. All overridable for tests. */
export interface FeedPaths {
	activity: string;
	checkResults: string;
	testEvents: string;
	mutationManifest: string;
	/** Per-run mutation ledger (run-log.ts). Optional so older FeedPaths
	 *  literals in tests stay valid; the feed derives it from the manifest's
	 *  directory when absent. */
	mutationRuns?: string;
}

/** Default feed paths under a project root's `.interlinked/` directory. */
export function defaultFeedPaths(root: string): FeedPaths {
	const dir = join(root, ".interlinked");
	return {
		activity: join(dir, "activity.jsonl"),
		checkResults: join(dir, "check-results.jsonl"),
		testEvents: join(dir, "test-events.jsonl"),
		mutationManifest: join(dir, "mutation-manifest.json"),
		mutationRuns: join(dir, "mutation-runs.jsonl"),
	};
}

/** Tail the per-run mutation ledger: parse each appended JSONL row, skip torn
 *  lines. Same poll cadence as the other JSONL feeds. */
function createRunsTailer(
	path: string,
	onEvent: (ev: unknown) => void,
	pollMs: number,
): { stop: () => void } {
	let offset = existsSync(path) ? statSync(path).size : 0;
	const iv = setInterval(() => {
		const read = readAppendedLines(path, offset);
		offset = read.offset;
		for (const line of read.lines) {
			try {
				onEvent(JSON.parse(line));
			} catch (err) {
				void err; // torn tail line from a live writer — next poll completes it
			}
		}
	}, pollMs);
	iv.unref();
	return { stop: () => clearInterval(iv) };
}

/** The run ledger's path for a FeedPaths, tolerating older literals. */
function mutationRunsPath(paths: FeedPaths): string {
	return paths.mutationRuns ?? join(dirname(paths.mutationManifest), "mutation-runs.jsonl");
}

/** Newest `max` run rows, oldest first, torn lines skipped. */
function seedMutationRuns(path: string, max: number): unknown[] {
	const rows: unknown[] = [];
	for (const line of readAppendedLines(path, 0).lines) {
		try {
			rows.push(JSON.parse(line));
		} catch (err) {
			void err;
		}
	}
	return rows.slice(-max);
}

/**
 * Seed the mutant lens with the manifest's CURRENT state, framed as `born`
 * events so a joining client renders the existing wall before any live flip.
 */
export function seedMutants(path: string): MutantEvent[] {
	return readMutantSnapshot(path).mutants.map((mutant) => ({ kind: "born", mutant }));
}

/**
 * Build the presence feed: fold the activity stream into per-actor lanes and
 * emit the UPDATED lane on every event. The roster is per-feed (one fold shared
 * by all connected browsers); the seed replays the backlog through the same fold
 * so a joining client gets the current roster, one presence per actor.
 */
function buildAgentFeed(activityPath: string, pollMs: number): VizFeed {
	const roster = new AgentRoster();
	return {
		route: "/api/agents",
		hello: "interlinked agent presence",
		seed: (): AgentPresence[] => {
			for (const ev of seedRecentEvents(activityPath, SEED_PRESENCE)) roster.apply(ev);
			return roster.list();
		},
		subscribe: (onEvent) => createActivityTailer(activityPath, (ev) => onEvent(roster.apply(ev)), pollMs),
	};
}

/**
 * Presence backlog. Larger than the ticker's: presence is a fold, so a short
 * window would under-report an agent that has been quiet for a few minutes but
 * is very much still working.
 */
const SEED_PRESENCE = 600;

/** Build every feed the dashboard hosts, wired to `paths`. */
export function buildFeeds(paths: FeedPaths, pollMs: number): VizFeed[] {
	return [
		{
			route: "/api/stream",
			hello: "interlinked baseline stream",
			seed: () => seedRecentEvents(paths.activity, SEED_EVENTS),
			subscribe: (onEvent) => createActivityTailer(paths.activity, onEvent, pollMs),
		},
		{
			route: "/api/checks",
			hello: "interlinked checks stream",
			seed: () => seedRecentChecks(paths.checkResults, SEED_EVENTS),
			subscribe: (onEvent) => createChecksTailer(paths.checkResults, onEvent, pollMs),
		},
		{
			route: "/api/tests",
			hello: "interlinked test stream",
			seed: () => seedRecentTestEvents(paths.testEvents, SEED_TESTS),
			subscribe: (onEvent) => createTestTailer(paths.testEvents, onEvent),
		},
		buildAgentFeed(paths.activity, pollMs),
		{
			route: "/api/mutants",
			hello: "interlinked mutant stream",
			seed: () => seedMutants(paths.mutationManifest),
			subscribe: (onEvent) => createMutantWatcher(paths.mutationManifest, onEvent),
		},
		{
			route: "/api/mutation-runs",
			hello: "interlinked mutation run stream",
			seed: () => seedMutationRuns(mutationRunsPath(paths), SEED_TESTS),
			subscribe: (onEvent) => createRunsTailer(mutationRunsPath(paths), onEvent, pollMs),
		},
	];
}
