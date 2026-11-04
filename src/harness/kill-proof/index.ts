// Kill proof — public surface. See types.ts for the contract.
export { proveKill, type ProveKillOptions } from "./run.js";
export {
	bytesFresh,
	captureEnvironment,
	freshKillsForTest,
	hashFile,
	KILL_PROOFS_DIR,
	killProofsDir,
	type KillProofIndex,
	type KillProofIndexRow,
	listKillProofIds,
	mutantLabel,
	parseKillProof,
	parseKillProofIndex,
	readKillProof,
	readKillProofIndex,
	receiptId,
	verifyKillProof,
	writeKillProof,
} from "./receipt.js";
export { relocate, type Resolved, resolveMutant } from "./resolve.js";
export type {
	CaseOutcome,
	CaseVerdict,
	Freshness,
	HashedFile,
	KillProofReceipt,
	MutantSpec,
	ProofEnvironment,
	ProofVerdict,
	ProveKillResult,
	ResolvedMutant,
} from "./types.js";
