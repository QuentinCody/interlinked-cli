// ===========================================
// interlinked harness stop / test — daemon shutdown + synthetic-event probe
// ===========================================
// Extracted from harness.ts to keep that file under the per-file line cap.
// Behavior is byte-identical; these are the same functions the stop / test
// commands have always called. Re-exported from ./harness.js so existing
// importers (disable.ts, registrars/harness.ts, harness.test.ts) keep a
// byte-for-byte-identical public API after the split.

import { existsSync } from "node:fs";
import { c } from "../lib/formatter.js";
import type { JsonObject } from "../lib/json-types.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { stopAllDaemons } from "./harness-daemon-control.js";
import { getSocketPath } from "./harness-process.js";
import { queryHarness } from "./harness-status-helpers.js";
import {
	buildHarnessTestEvent,
	type HarnessTestOpts,
	resolveHarnessTestInput,
} from "./harness-test-event.js";

// ===========================================
// harness stop
// ===========================================

/**
 * Stop EVERY daemon this repo owns, not just the one named in `harness.pid`.
 *
 * Measured 2026-08-15: `interlinked disable` stopped the pid-file daemon and
 * left two orphan daemons running — a stood-down repo still being guarded by
 * processes nothing tracked. `stopAllDaemons` enumerates the per-session pid
 * files AND the `ps`-visible orphans, records one `explicit-stop` ledger marker
 * so the resulting exits classify as PLANNED, and signals them all.
 */
export async function harnessStopCommand(opts: { json?: boolean }): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();

	try {
		const { stopped, survived } = await stopAllDaemons(cwd);
		if (stopped.length === 0 && survived.length === 0) {
			output(
				mode,
				{ stopped: false },
				{
					json: () => ({ status: "not_running" }),
					normal: () => c.dim("Harness is not running."),
				},
			);
			return;
		}

		output(
			mode,
			{ stopped: survived.length === 0, pids: stopped, survived },
			{
				json: () => ({
					status: survived.length > 0 ? "still_running" : "stopped",
					pids: stopped,
					survived,
				}),
				normal: () =>
					survived.length > 0
						? c.yellow(
								`Stopped ${stopped.length} daemon(s); PID(s) ${survived.join(", ")} survived SIGKILL. Investigate process permissions or kernel state manually.`,
							)
						: c.green(`Harness stopped (${stopped.length} daemon(s): ${stopped.join(", ")})`),
			},
		);
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

// ===========================================
// harness test
// ===========================================

export async function harnessTestCommand(
	command: string | undefined,
	opts: HarnessTestOpts,
): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();

	try {
		// Resolve flags (--write/--edit/positional) + any --from-file/--stdin
		// content into a synthetic PreToolUse event. Pure construction lives in
		// ./harness-test-event.js so the flag→event mapping is unit-tested
		// without a live socket.
		const input = await resolveHarnessTestInput(command, opts, cwd);
		const { toolName, displayLabel, event } = buildHarnessTestEvent(input);
		// Gates that resolve the ledger / overlay (coverage debt, new-file debt)
		// need the project root; without it they fail closed. The builder omits it
		// (it's pure / cwd-free), so stamp it on the event here before sending.
		event.cwd = cwd;

		// Try harness first
		const socketExists = existsSync(getSocketPath(cwd));
		let decision: JsonObject | null = null;

		if (socketExists) {
			// A Write/Edit event can trigger the coverage overlay (vitest), which
			// takes seconds — far past the 2s status-ping default. `harness test`
			// is interactive, so wait for the real gate to finish.
			decision = await queryHarness(cwd, event, 60_000);
		}

		if (!decision) {
			output(
				mode,
				{ error: "harness_not_running" },
				{
					json: () => ({ error: "Harness not running" }),
					normal: () =>
						c.yellow("Harness not running. Start with: interlinked harness start"),
				},
			);
			return;
		}

		// Alias captured in the enclosing scope so the callback body narrows
		// the null check above without needing `!` assertions.
		const resolvedDecision: JsonObject = decision;
		output(mode, resolvedDecision, {
			json: () => resolvedDecision,
			normal: () => {
				const lines: string[] = [];
				const blocked = resolvedDecision.decision === "block";
				lines.push(
					`${blocked ? c.red("BLOCKED") : c.green("ALLOWED")} ${c.dim(`${toolName}:`)} ${displayLabel}`,
				);
				if (resolvedDecision.reason) {
					lines.push(`  ${resolvedDecision.reason}`);
				}
				if (resolvedDecision.warnings && Array.isArray(resolvedDecision.warnings)) {
					for (const w of resolvedDecision.warnings as string[]) {
						lines.push(`  ${c.yellow(w)}`);
					}
				}
				return lines.join("\n");
			},
		});

		if (decision.decision === "block") {
			process.exitCode = 1;
		}
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}
