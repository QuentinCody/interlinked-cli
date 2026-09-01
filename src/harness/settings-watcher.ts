// ===========================================
// Live filesystem watcher for Claude Code settings files
// ===========================================
//
// Closes the timing gap on malformed permission rules. Claude Code's
// "Always allow" UI writes settings.json from inside its own process
// (no tool call fires), so PreToolUse content guards in
// `evaluator/write-content-guards.ts` cannot intercept it. The
// existing `autoStripAllScopes` only runs at SessionStart — by which
// point Claude Code has already printed its "Invalid permission rule"
// warning to the terminal.
//
// This watcher runs continuously in the harness daemon, polling the
// four default settings paths (project + user × shared + local). When
// any of them changes, the strip is debounced briefly to coalesce
// rapid partial writes, then `autoStripAllScopes` rewrites the file
// without the malformed entries. Net effect: a malformed rule lives
// on disk for at most ~poll-interval + debounce-window before being
// removed, so the next session-start sees a clean file.
//
// Polling vs `fs.watch`: `watchFile` (polling) is used for the same
// reason `rules-loader.ts` uses it — `fs.watch` has well-known
// cross-platform quirks (macOS doesn't fire on some atomic-rename
// writes, Linux fires twice, etc.) and the daemon is long-lived so a
// 500 ms poll on four files is free.

import { unwatchFile, watchFile } from "node:fs";
import {
	type AutoStripResult,
	appendStripAuditLog,
	autoStripAllScopes,
	defaultSettingsPaths,
	defaultStripAuditLogPath,
	stripMalformedRulesAudited,
} from "../lib/settings-validator.js";

/** Poll interval default. Faster than `watchRulesFiles`'s 2 s because
 *  malformed permission rules are noisier than rule-config edits —
 *  Claude Code writes settings.json on every "Always allow" click, and
 *  we want to strip before the user opens a new terminal. 500 ms is
 *  the floor below which polling becomes a measurable CPU cost. */
const WATCH_POLL_INTERVAL_MS = 500;

/** Debounce window default: coalesce multiple writes (Claude Code can
 *  issue several writes in a row when it normalizes the file).
 *  Slightly longer than the poll interval so we batch across two
 *  polls. */
const STRIP_DEBOUNCE_MS = 750;

interface StripDebouncerOptions {
	cwd: string;
	/** Called every time a strip actually happens (i.e. at least one
	 *  malformed rule was removed). Receives the aggregated result so
	 *  the caller can log + invalidate caches. NOT called on noop
	 *  triggers. */
	onStrip: (result: AutoStripResult) => void;
	/** Override the four default paths (project + user × shared + local).
	 *  Tests pass a tmpdir-scoped list. */
	paths?: readonly string[];
	/** Override the audit-log path. Defaults to
	 *  `<cwd>/.interlinked/permission-rule-strips.jsonl` — same path
	 *  the SessionStart strip uses, so live-strip + SessionStart-strip
	 *  share one log. */
	auditLogPath?: string;
	/** Override debounce window. Tests pass small values. */
	debounceMs?: number;
}

interface StripDebouncer {
	/** Schedule a strip pass to run after the debounce window. Repeated
	 *  calls inside the window reset the timer (last-write-wins —
	 *  acceptable for our use case because `autoStripAllScopes` always
	 *  re-reads the current file state, so an older trigger followed by
	 *  newer writes still produces the right result). */
	trigger(): void;
	/** Cancel any pending strip. After this call no strip will run
	 *  unless `trigger()` is called again. */
	cancel(): void;
}

/** Build a debounced strip runner. Pure-logic, no filesystem
 *  observation — call `trigger()` from any source (the file watcher,
 *  a manual nudge, a test) and a strip will run after the debounce
 *  window elapses with no further triggers.
 *
 *  Separated from `watchSettingsFiles` so the debounce + strip
 *  behavior is testable with fake timers, while the actual `watchFile`
 *  wiring stays minimal glue. */
export function createStripDebouncer(opts: StripDebouncerOptions): StripDebouncer {
	const paths = opts.paths;
	const auditLogPath = opts.auditLogPath ?? defaultStripAuditLogPath(opts.cwd);
	const debounceMs = opts.debounceMs ?? STRIP_DEBOUNCE_MS;

	let pendingTimer: NodeJS.Timeout | null = null;
	let stripInFlight = false;

	const runStrip = () => {
		if (stripInFlight) return;
		stripInFlight = true;
		try {
			const result = paths !== undefined
				? autoStripScopedPaths(paths, auditLogPath)
				: autoStripAllScopes(opts.cwd, auditLogPath);
			if (result.totalStripped > 0) opts.onStrip(result);
		} catch (_err) {
			/* intentional: best-effort. If strip fails we'll try again on
			 * the next trigger; logging here would spam the daemon log on
			 * pathological cases (file mid-rename, permissions). */
		} finally {
			stripInFlight = false;
		}
	};

	const trigger = () => {
		if (pendingTimer !== null) clearTimeout(pendingTimer);
		if (debounceMs === 0) {
			pendingTimer = null;
			runStrip();
			return;
		}
		pendingTimer = setTimeout(() => {
			pendingTimer = null;
			runStrip();
		}, debounceMs);
		// `NodeJS.Timeout` promises `unref`, but tests (and non-Node timer
		// shims) can substitute a plain timer handle that lacks it — treat
		// the method as optional rather than trusting the declared type.
		// SAFETY: `NodeJS.Timeout` structurally satisfies `{ unref?: () => void }`,
		// so this narrows the assumed shape rather than lying about it.
		const timer = pendingTimer as { unref?: () => void };
		timer.unref?.();
	};

	const cancel = () => {
		if (pendingTimer !== null) {
			clearTimeout(pendingTimer);
			pendingTimer = null;
		}
	};

	return { trigger, cancel };
}

/** When a caller passes an explicit `paths` list (tests, or future
 *  scoped callers), strip only those files rather than the default
 *  four-path set. Mirrors `autoStripAllScopes` shape so the audit-log
 *  contract is identical. */
function autoStripScopedPaths(
	paths: readonly string[],
	auditLogPath: string,
): AutoStripResult {
	const entries: AutoStripResult["entries"] = [];
	let totalStripped = 0;
	for (const p of paths) {
		const r = stripMalformedRulesAudited(p);
		if (r.stripped > 0) {
			totalStripped = totalStripped + r.stripped;
			entries.push(...r.entries);
		}
	}
	if (entries.length > 0) appendStripAuditLog(auditLogPath, entries);
	return { totalStripped, entries };
}

interface SettingsWatcherOptions extends StripDebouncerOptions {
	/** Override polling interval. Tests pass a small value. Defaults
	 *  to 500 ms. */
	pollIntervalMs?: number;
}

/** Start watching settings files. Returns a cleanup function that
 *  removes all watchers and cancels any pending debounce timer. Safe
 *  to call the cleanup function more than once.
 *
 *  Default-path semantics: if `paths` is not provided, watches the
 *  four `defaultSettingsPaths(cwd)` entries (project + user × shared
 *  + local). `watchFile` is safe even when files do not yet exist —
 *  it fires once they appear, which is the right behavior for
 *  `.claude/settings.local.json` (often created mid-session). */
export function watchSettingsFiles(opts: SettingsWatcherOptions): () => void {
	const paths = opts.paths ?? defaultSettingsPaths(opts.cwd);
	const pollIntervalMs = opts.pollIntervalMs ?? WATCH_POLL_INTERVAL_MS;

	const debouncer = createStripDebouncer({ ...opts, paths });
	const onChange = () => debouncer.trigger();

	for (const path of paths) {
		watchFile(path, { interval: pollIntervalMs }, onChange);
	}
	// Close the startup race where a settings file is written before
	// watchFile has established its first baseline stat. The debounced strip
	// re-reads current file contents, so an immediate trigger is harmless on
	// clean files and catches malformed rules already present or written
	// during watcher startup.
	debouncer.trigger();

	let stopped = false;
	return () => {
		if (stopped) return;
		stopped = true;
		for (const path of paths) unwatchFile(path, onChange);
		debouncer.cancel();
	};
}
