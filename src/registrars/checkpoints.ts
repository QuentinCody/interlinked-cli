// ===========================================
// Checkpoint & git-bridge registrars — git checkpoint management
// (create/list/show/compare/prune/archive), the git metadata bridge
// (context, link-checkpoint), reservation git hooks (guard), and the
// working-tree restore commands (resume, rewind, reset).
// ===========================================

import { type Command, type OptionValues } from "commander";

export function registerCheckpointCommands(program: Command): void {
	registerCheckpointHistory(program);
	registerGitMetadata(program);
	registerReservationGuard(program);
	registerRestoration(program);
}

function checkpointOutput<T extends { json?: boolean }>(opts: T, command: Command) {
	return { ...opts, json: opts.json || command.parent?.opts().json };
}

function registerCheckpointHistory(program: Command): void {
	const cpCmd = program.command("checkpoint").description("Git checkpoint management");

	cpCmd
		.argument("[message]", "Checkpoint message")
		.option("--agent <name>", "Agent name")
		.option("--json", "Machine-readable output")
		.action(async (message: string | undefined, opts: { agent?: string; json?: boolean }) => {
			const { checkpointCommand } = await import("../commands/checkpoint.js");
			await checkpointCommand(message, opts);
		});

	cpCmd
		.command("list")
		.description("List checkpoints")
		.option("--agent <name>", "Filter by agent")
		.option("--since <duration>", "e.g. 1h, 1d")
		.option("--limit <n>", "Max entries")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues, cmd: Command) => {
			const merged = {
				...checkpointOutput(opts, cmd),
				agent: opts.agent || cmd.parent?.opts().agent,
			};
			const { checkpointListCommand } = await import("../commands/checkpoint.js");
			await checkpointListCommand(merged);
		});

	cpCmd
		.command("show <id>")
		.description("Show checkpoint details")
		.option("--json", "Machine-readable output")
		.action(async (id: string, opts: { json?: boolean }, cmd: Command) => {
			const merged = checkpointOutput(opts, cmd);
			const { checkpointShowCommand } = await import("../commands/checkpoint.js");
			await checkpointShowCommand(id, merged);
		});

	cpCmd
		.command("compare <id1> <id2>")
		.description("Diff two checkpoints")
		.option("--json", "Machine-readable output")
		.action(async (id1: string, id2: string, opts: { json?: boolean }, cmd: Command) => {
			const merged = checkpointOutput(opts, cmd);
			const { checkpointCompareCommand } = await import("../commands/checkpoint.js");
			await checkpointCompareCommand(id1, id2, merged);
		});

	cpCmd
		.command("prune")
		.description("Remove old checkpoints")
		.option("--older-than <days>", "Remove checkpoints older than N days")
		.option("--keep-latest <n>", "Keep the N most recent checkpoints")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues, cmd: Command) => {
			const merged = checkpointOutput(opts, cmd);
			const { checkpointPruneCommand } = await import("../commands/checkpoint.js");
			await checkpointPruneCommand(merged);
		});

	cpCmd
		.command("archive")
		.description("Archive old stash checkpoints to metadata-only")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues, cmd: Command) => {
			const merged = checkpointOutput(opts, cmd);
			const { checkpointArchiveCommand } = await import("../commands/checkpoint.js");
			await checkpointArchiveCommand(merged);
		});
}

function registerGitMetadata(program: Command): void {
	const gitCmd = program.command("git").description("Git bridge: metadata, trailers, and notes");

	gitCmd
		.command("context")
		.description("Show Interlinked metadata for HEAD or a commit")
		.option("--commit <sha>", "Specific commit (default: HEAD)")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { gitContextCommand } = await import("../commands/git.js");
			await gitContextCommand(opts);
		});

	gitCmd
		.command("link-checkpoint")
		.description("Link a server checkpoint to a git commit")
		.option("--checkpoint <id>", "Checkpoint ID (default: latest)")
		.option("--commit <sha>", "Commit SHA (default: HEAD)")
		.option("--apply", "Apply trailers and notes to HEAD (amends commit)")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { gitLinkCheckpointCommand } = await import("../commands/git.js");
			await gitLinkCheckpointCommand(opts);
		});
}

function registerReservationGuard(program: Command): void {
	const guardCmd = program.command("guard").description("File reservation enforcement via git hooks");

	guardCmd
		.command("install")
		.description("Install pre-commit hook for reservation checks")
		.option("--mode <mode>", "warn (default) or block", "warn")
		.option("--pre-push", "Also install pre-push hook")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { guardInstallCommand } = await import("../commands/guard.js");
			await guardInstallCommand(opts);
		});

	guardCmd
		.command("check")
		.description("Check files against active reservations")
		.option("--files <paths...>", "File paths to check (default: staged files)")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { guardCheckCommand } = await import("../commands/guard.js");
			await guardCheckCommand(opts);
		});

	guardCmd
		.command("status")
		.description("Show guard configuration and hook status")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { guardStatusCommand } = await import("../commands/guard.js");
			await guardStatusCommand(opts);
		});

	guardCmd
		.command("uninstall")
		.description("Remove guard hooks")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { guardUninstallCommand } = await import("../commands/guard.js");
			await guardUninstallCommand(opts);
		});
}

function registerRestoration(program: Command): void {
	program
		.command("resume [checkpoint-id]")
		.description("Resume from latest or specified checkpoint with context")
		.option("--agent <name>", "Filter by agent")
		.option("--json", "Machine-readable output")
		.action(async (id: string | undefined, opts: OptionValues) => {
			const { resumeCommand } = await import("../commands/resume.js");
			await resumeCommand(id, opts);
		});

	program
		.command("rewind [checkpoint-id]")
		.description("Restore working tree to a checkpoint state")
		.option("--force", "Discard uncommitted changes")
		.option("--list", "List checkpoints (shorthand)")
		.option("--json", "Machine-readable output")
		.action(async (id: string | undefined, opts: OptionValues) => {
			const { rewindCommand } = await import("../commands/rewind.js");
			await rewindCommand(id, opts);
		});

	program
		.command("reset")
		.description("Nuclear: clear all local state")
		.option("--force", "Required to confirm")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { resetCommand } = await import("../commands/reset.js");
			await resetCommand(opts);
		});
}
