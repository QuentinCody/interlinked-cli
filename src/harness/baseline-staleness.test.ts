import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAdoptCommands } from "../registrars/adopt.js";
import { registerQualityCommands } from "../registrars/quality.js";

// `defaultReadMtime`'s catch arm (statSync throwing after existsSync already
// reported the path present — a TOCTOU race in production) has no injectable
// seam: every other test in this file supplies its own `readMtime` and never
// touches the real fs default. A call-through spy poisons exactly one path's
// `statSync` (not a plain `vi.spyOn(fs, ...)`, which throws "Module namespace
// is not configurable in ESM" for node:fs under this vitest version) so every
// other fs call — including this file's own fixture writes — hits the real
// filesystem untouched.
const { statSyncControl } = vi.hoisted(() => ({
	// SAFETY: hoisted mock state has no real type to widen from; `string | null`
	// is the actual shape (a poisoned path, or none).
	statSyncControl: { poisonPath: null as string | null },
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		statSync: ((path: unknown, opts?: unknown) => {
			if (statSyncControl.poisonPath !== null && String(path) === statSyncControl.poisonPath) {
				throw new Error(`EACCES: permission denied, stat '${String(path)}'`);
			}
			return (actual.statSync as (p: unknown, o?: unknown) => unknown)(path, opts);
			// SAFETY: this wrapper implements the same call signature as the real
			// `statSync`; the cast restores that type after the `unknown`-typed
			// call-through above.
		}) as typeof actual.statSync,
	};
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectBaselineAges,
	DEFAULT_STALE_AFTER_DAYS,
	formatStaleBaselineWarning,
	NUDGE_INTERVAL_MS,
	shouldNudge,
	TRACKED_BASELINES,
} from "./baseline-staleness.js";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

/** mtime reader over a {basename: ageInDays} fixture; omitted => file absent. */
function reader(ages: Record<string, number>) {
	return (path: string): number | null => {
		const name = path.split("/").pop() ?? "";
		const days = ages[name];
		return days === undefined ? null : NOW - days * DAY;
	};
}

const fresh = (): Record<string, number> =>
	Object.fromEntries(TRACKED_BASELINES.map((b) => [b.file, 1]));

afterEach(() => {
	statSyncControl.poisonPath = null;
});

describe("collectBaselineAges — real fs default (no readMtime injected)", () => {
	it("reports a null age when statSync throws for a baseline that existsSync reported present", () => {
		const root = mkdtempSync(join(tmpdir(), "baseline-staleness-"));
		try {
			const target = join(root, "coverage-baseline.json");
			writeFileSync(target, "{}");
			statSyncControl.poisonPath = target;
			const ages = collectBaselineAges({ interlinkedDir: root, now: NOW });
			expect(ages.find((a) => a.file === "coverage-baseline.json")?.ageDays).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("collectBaselineAges", () => {
	it("reports whole-day ages for present baselines", () => {
		const ages = collectBaselineAges({
			interlinkedDir: "/repo/.interlinked",
			now: NOW,
			readMtime: reader({ ...fresh(), "coverage-baseline.json": 42 }),
		});
		expect(ages.find((a) => a.file === "coverage-baseline.json")?.ageDays).toBe(42);
	});

	it("reports null age for a baseline that was never generated", () => {
		const missing = fresh();
		delete missing["untested-files-baseline.json"];
		const ages = collectBaselineAges({
			interlinkedDir: "/repo/.interlinked",
			now: NOW,
			readMtime: reader(missing),
		});
		expect(ages.find((a) => a.file === "untested-files-baseline.json")?.ageDays).toBeNull();
	});

	it("covers every tracked baseline", () => {
		const ages = collectBaselineAges({
			interlinkedDir: "/repo/.interlinked",
			now: NOW,
			readMtime: reader(fresh()),
		});
		expect(ages.map((a) => a.file)).toEqual(TRACKED_BASELINES.map((b) => b.file));
	});
});

describe("shouldNudge — keeps the reminder bounded", () => {
	it("nudges when no marker exists (never nudged before)", () => {
		expect(shouldNudge({ interlinkedDir: "/repo/.interlinked", now: NOW, readMtime: () => null })).toBe(
			true,
		);
	});

	it("stays silent when the last nudge was recent", () => {
		const recent = NOW - NUDGE_INTERVAL_MS / 2;
		expect(
			shouldNudge({ interlinkedDir: "/repo/.interlinked", now: NOW, readMtime: () => recent }),
		).toBe(false);
	});

	it("nudges again once the interval has elapsed", () => {
		const old = NOW - NUDGE_INTERVAL_MS;
		expect(shouldNudge({ interlinkedDir: "/repo/.interlinked", now: NOW, readMtime: () => old })).toBe(
			true,
		);
	});
});

describe("formatStaleBaselineWarning — stays quiet (negative cases)", () => {
	it("returns null when every baseline is fresh", () => {
		expect(
			formatStaleBaselineWarning({
				interlinkedDir: "/repo/.interlinked",
				now: NOW,
				readMtime: reader(fresh()),
			}),
		).toBeNull();
	});

	it("returns null at exactly one day under the threshold", () => {
		const ages = Object.fromEntries(
			TRACKED_BASELINES.map((b) => [b.file, DEFAULT_STALE_AFTER_DAYS - 1]),
		);
		expect(
			formatStaleBaselineWarning({
				interlinkedDir: "/repo/.interlinked",
				now: NOW,
				readMtime: reader(ages),
			}),
		).toBeNull();
	});

	it("honours a caller-supplied threshold that tolerates the age", () => {
		const ages = Object.fromEntries(TRACKED_BASELINES.map((b) => [b.file, 30]));
		expect(
			formatStaleBaselineWarning({
				interlinkedDir: "/repo/.interlinked",
				now: NOW,
				staleAfterDays: 90,
				readMtime: reader(ages),
			}),
		).toBeNull();
	});
});

describe("formatStaleBaselineWarning — fires (positive cases)", () => {
	it("names a baseline that is past the threshold, with its age", () => {
		const out = formatStaleBaselineWarning({
			interlinkedDir: "/repo/.interlinked",
			now: NOW,
			readMtime: reader({ ...fresh(), "coverage-baseline.json": 44 }),
		});
		expect(out).toContain("coverage-baseline.json — 44d old");
		expect(out).toContain("[interlinked:baseline-staleness]");
	});

	it("treats an ABSENT baseline as stale — not measuring is not passing", () => {
		const missing = fresh();
		delete missing["untested-files-baseline.json"];
		const out = formatStaleBaselineWarning({
			interlinkedDir: "/repo/.interlinked",
			now: NOW,
			readMtime: reader(missing),
		});
		expect(out).toContain("untested-files-baseline.json — never generated");
	});

	it("fires exactly at the threshold boundary", () => {
		const out = formatStaleBaselineWarning({
			interlinkedDir: "/repo/.interlinked",
			now: NOW,
			readMtime: reader({ ...fresh(), "coverage-baseline.json": DEFAULT_STALE_AFTER_DAYS }),
		});
		expect(out).not.toBeNull();
	});

	it("lists each stale baseline and dedupes the refresh commands", () => {
		const out =
			formatStaleBaselineWarning({
				interlinkedDir: "/repo/.interlinked",
				now: NOW,
				readMtime: reader({ "coverage-baseline.json": 40, "coverage-edit-baseline.json": 40 }),
			}) ?? "";
		// Both coverage baselines share one refresh command; it must appear once.
		const occurrences = out.split("interlinked coverage check --update-baseline").length - 1;
		expect(occurrences).toBe(1);
		expect(out).toContain("coverage-baseline.json");
		expect(out).toContain("coverage-edit-baseline.json");
	});
});

// ---------------------------------------------------------------------------
// The refresh commands must EXIST. Followup #27a: this table pointed at
// `interlinked metrics --update-baseline`, which has never been a command, so
// the nudge that says "your measurement is out of date" ended in
// command-not-found. Pinned the way readme_script_drift pins README commands —
// against the CLI's own tables (here the registrars index.ts wires), not by
// spawning the binary.
// ---------------------------------------------------------------------------
describe("TRACKED_BASELINES — every suggested refresh command exists in the CLI", () => {
	/** Registrars owning every root verb this table may name. A refresh command
	 *  rooted anywhere else fails P1 rather than silently passing. */
	function buildProgram(): Command {
		const program = new Command();
		registerQualityCommands(program); // coverage, mutation, metrics, verify, write…
		registerAdoptCommands(program); // adopt
		return program;
	}

	/** Walk a command path (`["coverage","check"]`) through the tree. */
	function resolveCommand(program: Command, path: readonly string[]): Command | null {
		let current: Command = program;
		for (const token of path) {
			const next = current.commands.find((c) => c.name() === token || c.aliases().includes(token));
			if (!next) return null;
			current = next;
		}
		return current === program ? null : current;
	}

	const parsed = TRACKED_BASELINES.map((b) => {
		const words = b.refresh.split(/\s+/).slice(1);
		return {
			file: b.file,
			refresh: b.refresh,
			root: b.refresh.split(/\s+/)[0],
			path: words.filter((w) => !w.startsWith("-")),
			flags: words.filter((w) => w.startsWith("--")),
		};
	});
	const withFlags = parsed.filter((p) => p.flags.length > 0);

	it.each(parsed)("P1: `$refresh` resolves to a registered command", ({ path, root, refresh }) => {
		expect(root).toBe("interlinked");
		expect(resolveCommand(buildProgram(), path), `${refresh} names no registered command`).not.toBeNull();
	});

	it.each(withFlags)("P2: `$refresh` names only declared options", ({ path, flags, refresh }) => {
		const declared = (resolveCommand(buildProgram(), path)?.options ?? []).map((o) => o.long);
		const missing = flags.filter((f) => !declared.includes(f));
		expect(missing, `${refresh} names undeclared option(s)`).toEqual([]);
	});

	it("N1: the pin can fail — an invented command does NOT resolve", () => {
		expect(resolveCommand(buildProgram(), ["metrics", "update-baseline"])).toBeNull();
		expect(resolveCommand(buildProgram(), ["coverage", "refresh"])).toBeNull();
	});

	it("N2: the dead mutation-baseline ratchet is no longer nudged at all", () => {
		expect(TRACKED_BASELINES.map((b) => b.file)).not.toContain("mutation-baseline.json");
	});
});
