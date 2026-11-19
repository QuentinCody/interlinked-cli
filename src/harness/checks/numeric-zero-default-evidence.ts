import { AsyncLocalStorage } from "node:async_hooks";

/** Query evidence from the already-maintained importer index. Partial candidates
 * establish positive current edges, without proving complete reverse coverage. */
export interface NumericZeroDefaultEvidence {
	root: string;
	importers: (file: string) => { files: readonly string[]; complete: boolean; reason?: string };
	readFile?: (file: string) => string;
	onUnavailable?: (input: { file: string; reason: string }) => void;
}
const active = new AsyncLocalStorage<NumericZeroDefaultEvidence | undefined>();
export function withNumericZeroDefaultEvidence<T>(evidence: NumericZeroDefaultEvidence | undefined, run: () => T): T { return active.run(evidence, run); }
export function getNumericZeroDefaultEvidence(): NumericZeroDefaultEvidence | undefined { return active.getStore(); }
