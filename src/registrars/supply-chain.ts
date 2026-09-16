// ===========================================
// Supply-chain registrar — interlinked allowlist: fail-closed package
// approvals across npm / pypi / cargo / rubygems / go. Per-package grants
// and lockfile-snapshot grants over .interlinked/package-allowlist.json.
// ===========================================

import { type Command } from "commander";

export function registerSupplyChainCommands(program: Command): void {
	const alCmd = program
		.command("allowlist")
		.description(
			"Manage the supply-chain package allowlist (.interlinked/package-allowlist.json)",
		);

    registerPackageApprovalCommands(alCmd);
    registerProposalCommand(alCmd);

	alCmd
		.command("list")
		.description("Show approved packages and snapshots")
		.option("--ecosystem <name>", "Filter by ecosystem")
		.option("--json", "Machine-readable output")
		.option("--cwd <path>", "Project root")
		.action(async (opts: { ecosystem?: string; json?: boolean; cwd?: string }) => {
			const { listAllowlistCommand } = await import("../commands/allowlist.js");
			listAllowlistCommand({
				cwd: opts.cwd || process.cwd(),
				...(opts.ecosystem !== undefined ? { ecosystem: opts.ecosystem } : {}),
				...(opts.json !== undefined ? { json: opts.json } : {}),
			});
		});

	alCmd
		.command("snapshot")
		.description("Hash current manifest+lockfile state, store as an approved snapshot")
		.option("--by <name>", "Approver name (required)")
		.option("--reason <text>", "Why this state is approved")
		.option("--lockfile <name>", "Snapshot a specific file only (e.g. package-lock.json)")
		.option("--cwd <path>", "Project root")
		.action(
			async (opts: { by?: string; reason?: string; lockfile?: string; cwd?: string }) => {
				if (!opts.by) {
					process.stderr.write("error: --by <name> is required\n");
					process.exit(2);
				}
				const { snapshotAllowlistCommand } = await import("../commands/allowlist.js");
				snapshotAllowlistCommand({
					cwd: opts.cwd || process.cwd(),
					by: opts.by,
					...(opts.reason !== undefined ? { reason: opts.reason } : {}),
					...(opts.lockfile !== undefined ? { lockfile: opts.lockfile } : {}),
				});
			},
		);

	alCmd
		.command("verify")
		.description("Show manifest deps not on the allowlist")
		.option("--cwd <path>", "Project root")
		.action(async (opts: { cwd?: string }) => {
			const { verifyAllowlistCommand } = await import("../commands/allowlist.js");
			verifyAllowlistCommand({ cwd: opts.cwd || process.cwd() });
		});
}

function registerPackageApprovalCommands(alCmd: Command): void {
	alCmd
		.command("add <ecosystem> <package>")
		.description("Approve a registry package (ecosystem: npm | pypi | cargo | rubygems | go)")
		.option("--by <name>", "Approver name (required)")
		.option("--reason <text>", "Why this package is approved")
		.option("--version-range <range>", "Optional semver/PEP-440 range constraint")
		.option(
			"--force",
			"Override the admission screens (typosquat refusal, non-allowlisted license, open OSV advisories)",
		)
		.option("--cwd <path>", "Project root (default: current directory)")
		.action(
			async (
				ecosystem: string,
				pkg: string,
				opts: {
					by?: string;
					reason?: string;
					versionRange?: string;
					force?: boolean;
					cwd?: string;
				},
			) => {
				if (!opts.by) {
					process.stderr.write("error: --by <name> is required\n");
					process.exit(2);
				}
				const { addAllowlistCommand } = await import("../commands/allowlist.js");
				try {
					await addAllowlistCommand(ecosystem, pkg, {
						cwd: opts.cwd || process.cwd(),
						by: opts.by,
						...(opts.reason !== undefined ? { reason: opts.reason } : {}),
						...(opts.versionRange !== undefined
							? { versionRange: opts.versionRange }
							: {}),
						...(opts.force !== undefined ? { force: opts.force } : {}),
					});
				} catch (err) {
					process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
					process.exit(2);
				}
			},
		);

	alCmd
		.command("remove <ecosystem> <package>")
		.description("Un-approve a previously-approved package")
		.option("--cwd <path>", "Project root")
		.action(async (ecosystem: string, pkg: string, opts: { cwd?: string }) => {
			const { removeAllowlistCommand } = await import("../commands/allowlist.js");
			removeAllowlistCommand(ecosystem, pkg, { cwd: opts.cwd || process.cwd() });
		});

}

function registerProposalCommand(alCmd: Command): void {
    alCmd.command("propose <ecosystem> <package>")
        .description("Record a dependency request without changing approval or installing it")
        .requiredOption("--package-version <version>", "Requested package version")
        .requiredOption("--reason <text>", "Why the dependency is needed")
        .option("--cwd <path>", "Project root")
        .option("--json", "Machine-readable proposal")
        .action(async (ecosystem: string, pkg: string, options: { packageVersion: string; reason: string; cwd?: string; json?: boolean }) => {
            const { proposeAllowlistCommand } = await import("../commands/allowlist-propose.js");
            proposeAllowlistCommand(ecosystem, pkg, { ...options, version: options.packageVersion });
        });
}
