import { mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../lib/json-types.js";
import { CohortManager } from "./cohort.js";
import { externalOriginOf } from "./evaluator/external-origin-files.js";
import { evaluatePostToolUse } from "./evaluator/post-tool.js";
import {
	EXTERNAL_ORIGIN_MAX_FILES,
	externalOriginEntries,
	type ExternalOriginFile,
	restoreExternalOrigins,
	serializeExternalOrigins,
	setExternalOriginEntries,
} from "./external-origin-store.js";
import { ReservationManager } from "./reservations.js";
import { getDefaultConfig } from "./rules-loader.js";
import { SessionTracker } from "./session-state.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";

// Built at run time so this source file carries no literal key shape.
const KEY = ["AIza", "SyB3xQ7mNp2LkR8vT1wZ5cH9jF4gD6sA0eU"].join("");
const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const SID = "ext-origin-persist";

let dir: string;
beforeEach(() => {
	// Canonical (macOS /var → /private/var): registry entries hold real paths.
	dir = realpathSync(mkdtempSync(join(tmpdir(), "ext-origin-store-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function event(overrides: Partial<HarnessEvent>): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: SID,
		agent_name: "alice",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: {},
		tool_response: "",
		cwd: dir,
		timestamp: "2026-10-05T00:00:00.000Z",
		...overrides,
	};
}

/** One PostToolUse through the tracker + evaluator, as the daemon runs it. */
function run(tracker: SessionTracker, overrides: Partial<HarnessEvent>): SessionTrajectory {
	const ev = event(overrides);
	const session = tracker.recordEvent(ev);
	evaluatePostToolUse(ev, getDefaultConfig(), session, new ReservationManager(), new CohortManager());
	return session;
}

function fetchPage(tracker: SessionTracker, name: string, extra: Partial<HarnessEvent> = {}): string {
	const p = join(dir, name);
	writeFileSync(p, `<script>ytcfg.set({"INNERTUBE_API_KEY":"${KEY}"})</script>`);
	run(tracker, { tool_input: { command: `curl -sL -o ${name} ${YT}` }, ...extra });
	return p;
}

/** Serialize through JSON text, as `<id>.live.json` does, into a fresh tracker. */
function restart(tracker: SessionTracker): { tracker: SessionTracker; session: SessionTrajectory } {
	const snap = tracker.serialize(SID);
	if (!snap) throw new Error("no snapshot");
	// SAFETY: serialize() returned a JsonObject; the JSON text round trip keeps that shape.
	const reloaded = JSON.parse(JSON.stringify(snap)) as JsonObject;
	const next = new SessionTracker();
	const session = next.hydrate(reloaded);
	if (!session) throw new Error("hydrate failed");
	return { tracker: next, session };
}

function entry(path: string): ExternalOriginFile {
	const st = statSync(path);
	return { path, source: YT, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, recorded_at: 1 };
}

describe("external-origin registry persistence — positive (must survive)", () => {
	it("P1: registry survives a snapshot round trip (path, source, fingerprint, recorded_at)", () => {
		const tracker = new SessionTracker();
		const p = fetchPage(tracker, "yt.html");
		const { session } = restart(tracker);
		const got = externalOriginOf(session, p);
		expect(got?.source).toBe(YT);
		expect(got?.recorded_at).toBeGreaterThan(0);
		expect(got?.size).toBe(statSync(p).size);
	});

	it("P2: a fetched, unchanged page still reads as public after a restart (no ratchet)", () => {
		const tracker = new SessionTracker();
		fetchPage(tracker, "yt.html");
		const { tracker: next, session } = restart(tracker);
		run(next, { tool_input: { command: `rg -o '"INNERTUBE_API_KEY":"[^"]+"' yt.html` }, tool_response: `"INNERTUBE_API_KEY":"${KEY}"` });
		expect(session.sensitivity_level).toBe("Public");
	});

	it("P3: reload ignores the 120-second recording window (an old entry with an unchanged file is kept)", () => {
		const p = join(dir, "old.html");
		writeFileSync(p, "<html/>");
		utimesSync(p, 1_000_000, 1_000_000); // 1970-01-12: far outside any 120 s window
		const s = new SessionTracker().recordEvent(event({}));
		expect(restoreExternalOrigins(s, [{ ...entry(p) }])).toBe(1);
		expect(externalOriginOf(s, p)).toBeDefined();
	});
});

describe("external-origin registry persistence — negative (must drop or write nothing)", () => {
	it("N1: an entry whose file changed while the daemon was down is dropped on load", () => {
		const tracker = new SessionTracker();
		const p = fetchPage(tracker, "yt.html");
		const snap = tracker.serialize(SID);
		writeFileSync(p, `local edit ${KEY} and more bytes`);
		const next = new SessionTracker();
		const session = next.hydrate(JSON.parse(JSON.stringify(snap)));
		if (!session) throw new Error("hydrate failed");
		expect(externalOriginEntries(session)).toEqual([]);
	});

	it("N2: an entry whose file vanished is dropped on load", () => {
		const tracker = new SessionTracker();
		const p = fetchPage(tracker, "yt.html");
		const snap = tracker.serialize(SID);
		rmSync(p);
		const session = new SessionTracker().hydrate(JSON.parse(JSON.stringify(snap)));
		if (!session) throw new Error("hydrate failed");
		expect(externalOriginEntries(session)).toEqual([]);
	});

	it("N3: a dry_run fetch records nothing, so the snapshot carries no entry", () => {
		const tracker = new SessionTracker();
		fetchPage(tracker, "yt.html", { dry_run: true });
		expect(tracker.serialize(SID)?.external_origin_files).toEqual([]);
	});

	it("N4: a snapshot without the field (pre-fix) hydrates with an empty registry", () => {
		const tracker = new SessionTracker();
		fetchPage(tracker, "yt.html");
		const snap = tracker.serialize(SID);
		if (!snap) throw new Error("no snapshot");
		delete snap.external_origin_files;
		const session = new SessionTracker().hydrate(JSON.parse(JSON.stringify(snap)));
		expect(session && externalOriginEntries(session)).toEqual([]);
	});

	it("N5: malformed entries (relative path, missing number, non-object) are dropped", () => {
		const p = join(dir, "a.html");
		writeFileSync(p, "x");
		const s = new SessionTracker().recordEvent(event({}));
		const good = entry(p);
		const kept = restoreExternalOrigins(s, [
			{ ...good, path: "a.html" },
			{ ...good, ino: "1" },
			[good],
			null,
			good,
		]);
		expect(kept).toBe(1);
		expect(externalOriginEntries(s).map((e) => e.path)).toEqual([p]);
	});

	it("N6: a non-array field restores nothing", () => {
		const s = new SessionTracker().recordEvent(event({}));
		expect(restoreExternalOrigins(s, { path: "/x" })).toBe(0);
		expect(externalOriginEntries(s)).toEqual([]);
	});

	it("N7: the 512-entry bound holds on set and on reload", () => {
		const p = join(dir, "a.html");
		writeFileSync(p, "x");
		const s = new SessionTracker().recordEvent(event({}));
		const many = Array.from({ length: EXTERNAL_ORIGIN_MAX_FILES + 5 }, (_, i) => ({ ...entry(p), recorded_at: i + 1 }));
		setExternalOriginEntries(s, many);
		expect(externalOriginEntries(s)).toHaveLength(EXTERNAL_ORIGIN_MAX_FILES);
		expect(externalOriginEntries(s)[0]?.recorded_at).toBe(6);
		expect(restoreExternalOrigins(s, serializeExternalOrigins(s).concat(serializeExternalOrigins(s)))).toBe(EXTERNAL_ORIGIN_MAX_FILES);
	});
});
