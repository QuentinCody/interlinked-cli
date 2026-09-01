// ===========================================
// interlinked reminder — File reminder management
// ===========================================

import { createHash } from "node:crypto";
import {
	readLocalGuardRules,
	readTeamGuardRules,
	writeLocalGuardRules,
	writeTeamGuardRules,
} from "../harness/rules-loader.js";
import type { FileReminder } from "../harness/types.js";
import { readLocalConfig } from "../lib/config.js";
import { c } from "../lib/formatter.js";
import { nonNull } from "../lib/non-null.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

// ===========================================
// Helpers
// ===========================================

function generateId(glob: string): string {
	const hash = createHash("sha256").update(glob).digest("hex").slice(0, 8);
	return `reminder-${hash}`;
}

interface AnnotatedReminder extends FileReminder {
	source: "team" | "local";
}

function formatReminder(r: AnnotatedReminder): string {
	const ops = r.operations?.length ? r.operations.join(",") : "any op";
	const freq = r.once_per_session === false ? "every time" : "once";
	const source = r.source === "team" ? c.cyan("[team]") : c.yellow("[local]");
	const by = r.created_by ? c.dim(` by ${r.created_by}`) : "";
	return `  ${c.bold(r.glob.padEnd(28))} ${c.dim('"')}${r.message}${c.dim('"')}  ${source} ${c.dim(`[${ops}]`)} ${c.dim(`[${freq}]`)}${by}`;
}

// ===========================================
// Commands
// ===========================================

export function reminderAddCommand(opts: {
	glob?: string;
	message?: string;
	ops?: string;
	once?: boolean;
	id?: string;
	team?: boolean;
	json?: boolean;
}): void {
	const mode = getOutputMode(opts);

	if (!opts.glob || !opts.message) {
		outputError(mode, "--glob and --message are required");
		return;
	}

	const id = opts.id || generateId(opts.glob);
	const operations = opts.ops ? opts.ops.split(",").map((s) => s.trim()) : undefined;
	const localConfig = readLocalConfig();
	const createdBy = localConfig?.agent_name || "cli";

	const reminder: FileReminder = {
		glob: opts.glob,
		message: opts.message,
		id,
		...(operations && { operations }),
		once_per_session: opts.once !== false,
		created_at: new Date().toISOString(),
		created_by: createdBy,
	};

	const read = opts.team ? readTeamGuardRules : readLocalGuardRules;
	const write = opts.team ? writeTeamGuardRules : writeLocalGuardRules;

	const existing = read() || {};
	const reminders: FileReminder[] =
		(existing.file_reminders as FileReminder[] | undefined) ?? [];

	const duplicate = reminders.find((r) => r.id === id);
	if (duplicate) {
		outputError(mode, `Reminder with id "${id}" already exists for glob "${duplicate.glob}"`);
		return;
	}

	reminders.push(reminder);
	existing.file_reminders = reminders;
	write(existing);

	const target = opts.team ? "guard-rules.json" : "guard-rules.local.json";
	output(mode, reminder, {
		json: () => ({ added: reminder, file: target }),
		normal: () =>
			`${c.green("Added")} reminder ${c.bold(id)} for ${c.cyan(opts.glob!)}\n  "${opts.message}"\n  Written to .interlinked/${target}`,
	});
}

export function reminderListCommand(opts: {
	json?: boolean;
	short?: boolean;
	full?: boolean;
}): void {
	const mode = getOutputMode(opts);

	const teamRules = readTeamGuardRules();
	const localRules = readLocalGuardRules();

	const teamReminders: AnnotatedReminder[] = (
		(teamRules?.file_reminders as FileReminder[] | undefined) ?? []
	).map((r) => ({
		...r,
		source: "team" as const,
	}));
	const localReminders: AnnotatedReminder[] = (
		(localRules?.file_reminders as FileReminder[] | undefined) ?? []
	).map((r) => ({
		...r,
		source: "local" as const,
	}));

	const all = [...teamReminders, ...localReminders];

	output(mode, all, {
		json: () => all,
		short: () =>
			all.length === 0 ? "No active reminders" : `${all.length} active reminder(s)`,
		normal: () => {
			if (all.length === 0) return c.dim("No active file reminders");
			const lines = [`File Reminders (${all.length} active)\n`];
			for (const r of all) {
				lines.push(formatReminder(r));
			}
			return lines.join("\n");
		},
	});
}

export function reminderRemoveCommand(
	idOrGlob: string | undefined,
	opts: {
		team?: boolean;
		all?: boolean;
		json?: boolean;
	},
): void {
	const mode = getOutputMode(opts);

	if (!opts.all && !idOrGlob) {
		outputError(mode, "Provide a reminder id or glob to remove, or use --all");
		return;
	}

	const read = opts.team ? readTeamGuardRules : readLocalGuardRules;
	const write = opts.team ? writeTeamGuardRules : writeLocalGuardRules;

	const existing = read() || {};
	const reminders: FileReminder[] =
		(existing.file_reminders as FileReminder[] | undefined) ?? [];

	if (opts.all) {
		const count = reminders.length;
		existing.file_reminders = [];
		write(existing);
		output(
			mode,
			{ removed: count },
			{
				json: () => ({ removed: count }),
				normal: () =>
					count === 0
						? c.dim("No reminders to remove")
						: `${c.green("Removed")} ${count} reminder(s)`,
			},
		);
		return;
	}

	const idx = reminders.findIndex((r) => r.id === idOrGlob || r.glob === idOrGlob);
	if (idx === -1) {
		outputError(mode, `No reminder found matching "${idOrGlob}"`);
		return;
	}

	const removed = reminders.splice(idx, 1)[0];
	existing.file_reminders = reminders;
	write(existing);

	output(mode, removed, {
		json: () => ({ removed }),
		normal: () =>
			`${c.green("Removed")} reminder ${c.bold(nonNull(removed).id || nonNull(removed).glob)}: "${nonNull(removed).message}"`,
	});
}
