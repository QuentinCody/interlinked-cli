import { runVitestDetailed, type VitestRun } from "../fail-before-fix/index.js";
import { type AsyncProjectCopy, createProjectCopyAsync } from "../fail-before-fix/snapshot.js";
import { hoistLayout, type ValidatedProofInputs } from "./proof-preconditions.js";
import { captureEnvironment, hashFile } from "./receipt.js";
import type { ProofContextOptions } from "./run.js";
import type { HashedFile, ProofEnvironment } from "./types.js";

/** Thrown out of a proof whose `signal` aborted; every copy made so far has been removed when it reaches the caller. */
export class ProofInterrupted extends Error {
	constructor() {
		super("kill proof interrupted before a verdict (SIGTERM or the --timeout deadline); copies removed, no receipt written");
		this.name = "ProofInterrupted";
	}
}

/** Above this many git-visible bytes a proof warns (round-4 M10): each run copies the tree again, three to five times per proof. */
export const COPY_BUDGET_BYTES = 256 * 1024 * 1024;
export function copySizeWarning(bytes: number): string | null {
	if (bytes <= COPY_BUDGET_BYTES) return null;
	return `[interlinked:kill-proof] copy is ${Math.round(bytes / 1024 / 1024)} MiB; large tracked files slow every proof`;
}

/** The inputs a proof runs against, hashed from the FROZEN copy (`dir`), never from the live tree. */
export interface FrozenInputs {
	dir: string;
	testHashes: HashedFile[];
	environment: ProofEnvironment;
}

function hashAll(root: string, paths: readonly string[]): HashedFile[] | string {
	const out: HashedFile[] = [];
	for (const path of paths) {
		const hashed = hashFile(root, path);
		if (hashed === null) return `${path} does not exist`;
		out.push(hashed);
	}
	return out;
}

type FrozenResult = FrozenInputs | { problem: string };

function inspectCopy(copy: AsyncProjectCopy, inputs: ValidatedProofInputs, warnings: string[]): FrozenResult {
	const sizeWarning = copySizeWarning(copy.bytes);
	if (sizeWarning !== null && !warnings.includes(sizeWarning)) warnings.push(sizeWarning);
	const testHashes = hashAll(copy.dir, inputs.tests);
	if (typeof testHashes === "string") return { problem: `${testHashes.replace(/ does not exist$/, "")} is not visible to git (ignored or outside the work tree), so it is not in the copy` };
	return { dir: copy.dir, testHashes, environment: captureEnvironment(copy.dir, inputs.configPath ?? undefined) };
}

function proofSource(inputs: ValidatedProofInputs, options: ProofContextOptions, warnings: string[], hoist: ReturnType<typeof hoistLayout>) {
	const { root, files, tests, configPath } = inputs;
	const runner = options.runner ?? runVitestDetailed;
	const vitestArgs = configPath === null ? [] : ["--config", configPath];
	const checkSignal = () => {
		if (options.signal?.aborted) throw new ProofInterrupted();
	};
	let source: AsyncProjectCopy | undefined;
	const freeze = async () => {
		checkSignal();
		source = await createProjectCopyAsync(root, files, new Map(), hoist);
		return inspectCopy(source, inputs, warnings);
	};
	const frozen = freeze();
	const active = new Set<Promise<VitestRun & { dir: string }>>();
	const runOnce = async (overrides: ReadonlyMap<string, string>) => {
		const snapshot = await frozen;
		if ("problem" in snapshot) throw new Error(snapshot.problem);
		checkSignal();
		const copy = await createProjectCopyAsync(snapshot.dir, files, overrides, hoist);
		try {
			const result = await runner(copy.dir, tests, options.budgetMs, vitestArgs);
			checkSignal();
			return { ...result, dir: copy.dir };
		} finally {
			await copy.cleanup();
		}
	};
	return {
		frozen,
		runIn(overrides: ReadonlyMap<string, string>) {
			const run = runOnce(overrides);
			active.add(run);
			const finished = () => { active.delete(run); };
			void run.then(finished, finished);
			return run;
		},
		async close() {
			// A rejected proof still owns any copies it acquired before the failure.
			await Promise.allSettled([frozen, ...active]);
			await source?.cleanup();
		},
	};
}

/** A context reads the live tree once. Every individual run uses a clone of that frozen source. */
export function createProofCopies(inputs: ValidatedProofInputs, options: ProofContextOptions) {
	const warnings: string[] = [];
	const hoist = options.runner ? undefined : hoistLayout(inputs.root);
	let current: ReturnType<typeof proofSource> | undefined;
	let closing = Promise.resolve();
	const source = () => current ??= proofSource(inputs, options, warnings, hoist);
	return {
		warnings,
		frozenInputs: () => source().frozen,
		runIn: (overrides: ReadonlyMap<string, string>) => source().runIn(overrides),
		close() {
			if (current) {
				const cleanup = current.close();
				current = undefined;
				closing = Promise.all([closing, cleanup]).then(() => {});
			}
			return closing;
		},
	};
}
