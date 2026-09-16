import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ECOSYSTEMS } from "./allowlist-ecosystems.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

interface ProposalOptions { cwd?: string; version: string; reason: string; json?: boolean; }

/** Local request only. Possession of this file does not grant approval. */
export function proposeAllowlistCommand(ecosystem: string, pkg: string, options: ProposalOptions): void {
    const mode = getOutputMode(options);
    try {
        if (!ECOSYSTEMS.some(value => value === ecosystem)) throw new Error(`Unknown ecosystem: ${ecosystem}`);
        for (const value of [pkg, options.version, options.reason]) {
            if (!value.trim() || value.length > 4096) throw new Error("Package, version and reason must be nonempty and at most 4096 characters");
        }
        const root = realpathSync(options.cwd ?? process.cwd());
        const proposal = { version: 1, id: randomUUID(), ecosystem, package: pkg, requestedVersion: options.version,
            reason: options.reason, proposedAt: new Date().toISOString(), status: "pending", writer: "unknown" };
        const directory = join(root, ".interlinked", "package-proposals");
        mkdirSync(directory, { recursive: true });
        const path = join(directory, `${proposal.id}.json`);
        writeFileSync(path, `${JSON.stringify(proposal, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        output(mode, { ...proposal, path, approvalChanged: false }, { normal: () => `Recorded dependency proposal ${proposal.id}. Approval is unchanged.\n${path}` });
    } catch (error) { outputError(mode, error instanceof Error ? error.message : "Unable to record dependency proposal"); }
}
