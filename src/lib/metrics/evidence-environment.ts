import { hashBytes } from "./inventory.js";

// Node otherwise copies these from the live process environment during spawn.
const SPAWN_PROPAGATED_KEYS = ["NODE_V8_COVERAGE", "_BPXK_AUTOCVT", "_CEE_RUNOPTS", "_TAG_REDIR_ERR", "_TAG_REDIR_IN", "_TAG_REDIR_OUT", "STEPLIB", "LIBPATH", "_EDC_SIG_DFLT", "_EDC_SUSV3"];

/** Keep values in memory; receipts retain only the digest of the exact child environment. */
export function captureEvidenceEnvironment(inherited: NodeJS.ProcessEnv = process.env): { environment: NodeJS.ProcessEnv; environmentHash: string } {
    const entries = Object.entries(inherited).filter((entry): entry is [string, string] => entry[1] !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const environment: NodeJS.ProcessEnv = Object.fromEntries(entries);
    Object.setPrototypeOf(environment, null);
    for (const key of SPAWN_PROPAGATED_KEYS) if (!Object.hasOwn(environment, key)) environment[key] = undefined;
    const environmentHash = hashBytes(JSON.stringify(["inherited-environment-v1", process.version, process.platform, process.arch, process.execArgv, entries]));
    return { environment, environmentHash };
}
