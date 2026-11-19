import { AsyncLocalStorage } from "node:async_hooks";

/** Candidate lookup is query evidence. A regex importer graph remains partial
 * even after initialization, and never establishes universal absence. */
export interface CommanderOptionEvidence {
	root: string;
	importers: (file: string) => { files: readonly string[]; complete: boolean; reason?: string };
	readFile?: (file: string) => string;
	onUnavailable?: (input: { file: string; reason: string }) => void;
}
const active = new AsyncLocalStorage<CommanderOptionEvidence | undefined>();

export function withCommanderOptionEvidence<T>(evidence: CommanderOptionEvidence | undefined, run: () => T): T {
	return active.run(evidence, run);
}

export function getCommanderOptionEvidence(): CommanderOptionEvidence | undefined { return active.getStore(); }
