import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";

/** The three-argument, text-output spawn form used by the tool runners. */
export type SpawnSyncStub = (
	command: string,
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;
