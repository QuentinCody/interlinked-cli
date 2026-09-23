// ===========================================
// Vitest reporter → the viz test feed
// ===========================================
// Emits one `test-events.jsonl` line per test case, in the exact order vitest
// finishes them, so the dashboard's TESTS lens shows the live run rather than a
// post-hoc summary.
//
// Deliberately imports NOTHING from vitest: it is duck-typed against the v4
// reporter surface (`onTestRunStart` / `onTestModuleStart` / `onTestCaseResult` /
// `onTestRunEnd`) and defensive about every field. A reporter that throws takes
// the host's suite down with it, so every hook is wrapped and every accessor is
// optional. That also means this file can be loaded by a repo whose vitest
// version differs from ours — unknown hooks simply never fire.
//
// Usage in any repo:
//   // vitest.config.ts
//   reporters: ["default", "interlinked-cli/viz-reporter"]

import { relative } from "node:path";
import { laneFromConfig, type TestLane } from "../test-lane.js";
import { appendTestEvent, type TestEvent, type TestStatus, testEventsPath, trimError } from "./test-events.js";

/** The slice of a vitest `TestCase` this reporter reads. All optional by design. */
interface DuckTestCase {
	name?: string;
	fullName?: string;
	module?: { moduleId?: string };
	result?: () => { state?: string; errors?: { message?: string }[] } | undefined;
	diagnostic?: () => { duration?: number } | undefined;
}

/** The slice of a vitest `TestModule` this reporter reads. */
interface DuckTestModule {
	moduleId?: string;
}

const STATE_TO_STATUS: Record<string, TestStatus> = {
	passed: "pass",
	failed: "fail",
	skipped: "skip",
	pending: "skip",
	todo: "todo",
};

/** Map a vitest result state onto the feed's closed status domain. */
export function statusForState(state: string | undefined): TestStatus | null {
	return (state !== undefined && STATE_TO_STATUS[state]) || null;
}

/** Repo-relative path for display; absolute paths outside the root pass through. */
export function relativeToRoot(root: string, moduleId: string | undefined): string | undefined {
	if (!moduleId) return undefined;
	const rel = relative(root, moduleId);
	return rel && !rel.startsWith("..") ? rel : moduleId;
}

/** First error message on a case, already trimmed to one line. */
function firstError(errors: { message?: string }[] | undefined): string | undefined {
	const message = errors?.[0]?.message;
	return message ? trimError(message) : undefined;
}

/** Monotonic-enough run id: the reporter only needs it unique per process. */
function newRunId(): string {
	return `${process.pid.toString(36)}-${Date.now().toString(36)}`;
}

export interface ReporterOptions {
	/** Project root used for path display and the default feed location. */
	root?: string;
	/** Override the feed path (tests inject a tmp path). */
	feedPath?: string;
	/** Sink override — defaults to the real appender. */
	write?: (path: string, ev: TestEvent) => boolean;
	/** Clock override so tests get deterministic timestamps. */
	now?: () => Date;
}

/**
 * The reporter. Exported as the module default so `reporters: ["…/viz-reporter"]`
 * resolves it, and named so tests can construct it with injected deps.
 */
export class InterlinkedVizReporter {
	private readonly feedPath: string;
	private readonly root: string;
	private readonly write: (path: string, ev: TestEvent) => boolean;
	private readonly now: () => Date;
	private runId = newRunId();
	private tally = { passed: 0, failed: 0, skipped: 0 };
	private startedAt = 0;
	private lane: TestLane = "unknown";

	onInit(context: { vite?: { config?: { configFile?: string | false } } }): void {
		const config = context.vite?.config?.configFile;
		this.lane = laneFromConfig(typeof config === "string" ? config : undefined);
	}

	constructor(opts: ReporterOptions = {}) {
		this.root = opts.root ?? process.cwd();
		this.feedPath = opts.feedPath ?? testEventsPath(this.root);
		this.write = opts.write ?? appendTestEvent;
		this.now = opts.now ?? (() => new Date());
	}

	/** Append one event, swallowing any sink failure. */
	private emit(ev: Omit<TestEvent, "ts" | "run_id">): void {
		try {
			this.write(this.feedPath, { ts: this.now().toISOString(), run_id: this.runId, lane: this.lane, ...ev });
		} catch (err) {
			void err; /* observability must never fail the host suite */
		}
	}

	onTestRunStart(): void {
		this.runId = newRunId();
		this.tally = { passed: 0, failed: 0, skipped: 0 };
		this.startedAt = this.now().getTime();
		this.emit({ kind: "run_start", label: "vitest" });
	}

	onTestModuleStart(module: DuckTestModule | undefined): void {
		const file = relativeToRoot(this.root, module?.moduleId);
		this.emit(file ? { kind: "file_start", file } : { kind: "file_start" });
	}

	onTestCaseResult(testCase: DuckTestCase | undefined): void {
		const result = testCase?.result?.();
		const status = statusForState(result?.state);
		if (!status) return;
		this.count(status);

		const ev: Omit<TestEvent, "ts" | "run_id"> = { kind: "test", status };
		const name = testCase?.fullName ?? testCase?.name;
		if (name) ev.name = name;
		const file = relativeToRoot(this.root, testCase?.module?.moduleId);
		if (file) ev.file = file;
		const ms = testCase?.diagnostic?.()?.duration;
		if (typeof ms === "number" && Number.isFinite(ms)) ev.ms = Math.round(ms);
		const error = firstError(result?.errors);
		if (error) ev.error = error;
		this.emit(ev);
	}

	onTestRunEnd(): void {
		this.emit({
			kind: "run_end",
			passed: this.tally.passed,
			failed: this.tally.failed,
			skipped: this.tally.skipped,
			ms: Math.max(0, this.now().getTime() - this.startedAt),
		});
	}

	/** Fold one verdict into the run tally (`todo` counts as skipped). */
	private count(status: TestStatus): void {
		if (status === "pass") this.tally.passed++;
		else if (status === "fail") this.tally.failed++;
		else this.tally.skipped++;
	}
}

export default InterlinkedVizReporter;
