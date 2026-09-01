// ===========================================
// interlinked uninstall-hooks — manifest-driven removal
// ===========================================
// Removes exactly the paths the installer added. Never touches unrelated
// config. See docs/design/free-cli-architecture.md §"Installer architecture".

import { manifestPath, uninstallHooks } from "../harness/installer.js";
import type { RunnerId } from "../harness/unified-event.js";

export interface UninstallHooksOptions {
	runner?: string;
	dryRun?: boolean;
	json?: boolean;
}

const VALID_RUNNERS = new Set<RunnerId>([
	"claude-code",
	"copilot-cli",
	"cursor",
	"gemini-cli",
	"codex",
	"opencode",
	"opencode2",
	"pi",
]);

export async function uninstallHooksCommand(options: UninstallHooksOptions): Promise<void> {
	const cwd = process.cwd();
	const runners = parseRunners(options.runner);
	const result = uninstallHooks({
		cwd,
		...(runners.length === 0 ? {} : { runners }),
		dryRun: options.dryRun === true,
	});

	if (options.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					ok: true,
					dry_run: options.dryRun === true,
					removed: result.removed,
					remaining: result.remaining,
					manifest_path: manifestPath(cwd),
				},
				null,
				2,
			)}\n`,
		);
		return;
	}

	const verb = options.dryRun ? "would remove" : "removed";
	process.stdout.write(`[interlinked] ${verb} ${result.removed.length} hook registration(s)\n`);
	for (const e of result.removed) {
		process.stdout.write(`  ${e.runner} ← ${e.settings_path}\n`);
	}
	if (result.remaining.length > 0) {
		process.stdout.write(`[interlinked] ${result.remaining.length} remaining:\n`);
		for (const e of result.remaining) {
			process.stdout.write(`  ${e.runner} ← ${e.settings_path}\n`);
		}
	}
}

function parseRunners(raw: string | undefined): RunnerId[] {
	if (!raw || raw === "all") return [];
	const parts = raw.split(",").map((s) => s.trim());
	const out: RunnerId[] = [];
	for (const part of parts) {
		if (VALID_RUNNERS.has(part as RunnerId)) out.push(part as RunnerId);
	}
	return out;
}
