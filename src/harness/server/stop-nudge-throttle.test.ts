import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { suppressRepeatedNudges } from "./stop-nudge-throttle.js";

/**
 * A Stop nudge that repeats verbatim while nothing has changed is not a
 * reminder — it is a loop.
 *
 * Observed in a real install: an agent finished its work and said "waiting on
 * your call for the commit and deploy". Stop fired the deferred-coverage nudge,
 * whose only remedies are "run the full suite" or "commit". The agent is
 * forbidden to commit without the user asking, so it repeated "waiting on your
 * call", which ended the turn, which fired the identical nudge again. The user
 * had to interrupt to break it.
 *
 * The rule: say it once. Say it again only when the underlying state changed,
 * which shows up as different text.
 */
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "nudge-throttle-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("suppressRepeatedNudges", () => {
	it("passes a nudge through the first time", () => {
		expect(suppressRepeatedNudges({ projectRoot: root, sessionId: "s1" }, ["deferred coverage: a.ts"])).toEqual([
			"deferred coverage: a.ts",
		]);
	});

	it("suppresses the identical nudge on the next Stop — the loop-breaker", () => {
		suppressRepeatedNudges({ projectRoot: root, sessionId: "s1" }, ["deferred coverage: a.ts"]);
		expect(suppressRepeatedNudges({ projectRoot: root, sessionId: "s1" }, ["deferred coverage: a.ts"])).toEqual([]);
	});

	it("speaks again when the state changed, because the text changed", () => {
		suppressRepeatedNudges({ projectRoot: root, sessionId: "s1" }, ["deferred coverage: a.ts"]);
		expect(suppressRepeatedNudges({ projectRoot: root, sessionId: "s1" }, ["deferred coverage: a.ts, b.ts"])).toEqual([
			"deferred coverage: a.ts, b.ts",
		]);
	});

	it("suppresses only the repeated nudge, not its companions", () => {
		suppressRepeatedNudges({ projectRoot: root, sessionId: "s1" }, ["old news"]);
		expect(suppressRepeatedNudges({ projectRoot: root, sessionId: "s1" }, ["old news", "brand new"])).toEqual(["brand new"]);
	});

	it("keeps sessions independent — another agent has not been told yet", () => {
		suppressRepeatedNudges({ projectRoot: root, sessionId: "s1" }, ["deferred coverage: a.ts"]);
		expect(suppressRepeatedNudges({ projectRoot: root, sessionId: "s2" }, ["deferred coverage: a.ts"])).toEqual([
			"deferred coverage: a.ts",
		]);
	});

	it("stays quiet when only a count moved — a ticking counter is not news", () => {
		// The bug this fixes: "11 workaround signal(s)" then "12 …" hashed
		// differently, so the identical sentence reappeared every single turn.
		suppressRepeatedNudges({ projectRoot: root, sessionId: "s1" }, ["11 workaround signal(s) this session"]);
		expect(
			suppressRepeatedNudges({ projectRoot: root, sessionId: "s1" }, ["12 workaround signal(s) this session"]),
		).toEqual([]);
	});

	it("still speaks when the nudge differs by more than its numbers", () => {
		suppressRepeatedNudges({ projectRoot: root, sessionId: "s1" }, ["3 deferred check(s): a.ts"]);
		expect(suppressRepeatedNudges({ projectRoot: root, sessionId: "s1" }, ["3 deferred check(s): b.ts"])).toEqual([
			"3 deferred check(s): b.ts",
		]);
	});

	it("returns an empty list unchanged", () => {
		expect(suppressRepeatedNudges({ projectRoot: root, sessionId: "s1" }, [])).toEqual([]);
	});

	it("never throws when the state directory cannot be written", () => {
		// A Stop reflection must not become an exception on a read-only tree; the
		// worst acceptable degradation is repeating itself.
		//
		// File-as-parent = ENOTDIR on every platform. NEVER a "/proc/…" path:
		// recursive mkdir under /proc spins forever on the Linux CI runner
		// (guard-state.test.ts finding 2026-06) — this file's /proc probe hung
		// the unit lane in runs 30412876710 and 30466905490 (shard 1).
		const fileAsParent = join(root, "not-a-directory");
		writeFileSync(fileAsParent, "x");
		expect(() =>
			suppressRepeatedNudges({ projectRoot: join(fileAsParent, "nested"), sessionId: "s1" }, ["x"]),
		).not.toThrow();
	});

	it("treats a corrupt marker as nothing-said, so a nudge is never silenced by it", () => {
		// A truncated or hand-mangled marker file is the one input that could make
		// the throttle swallow a nudge the agent has never seen. The read must fail
		// towards speaking: unparseable told-set means everything is still unsaid,
		// and the next write repairs the file.
		const marker = join(root, ".interlinked", "stop-nudges", "s1.json");
		mkdirSync(join(root, ".interlinked", "stop-nudges"), { recursive: true });
		writeFileSync(marker, '["deadbeef", tru');

		expect(suppressRepeatedNudges({ projectRoot: root, sessionId: "s1" }, ["deferred coverage: a.ts"])).toEqual([
			"deferred coverage: a.ts",
		]);
		expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual([expect.stringMatching(/^[0-9a-f]{16}$/)]);
	});

	it("still returns the nudges when persistence fails", () => {
		const fileAsParent = join(root, "not-a-directory-2");
		writeFileSync(fileAsParent, "x");
		expect(
			suppressRepeatedNudges({ projectRoot: join(fileAsParent, "nested"), sessionId: "s1" }, ["x"]),
		).toEqual(["x"]);
	});
});
