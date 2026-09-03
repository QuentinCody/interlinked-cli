// Companion smoke test for the extracted buildHarnessSpawnArgs module — moved
// verbatim out of harness-lifecycle-helpers.ts. Full argv-construction
// coverage lives in harness-lifecycle-helpers.mutation-kill.test.ts and
// harness-lifecycle-helpers.mutation-kill-luna.test.ts, which import this
// same export via the parent's re-export; this file exercises the module
// directly at its new home.

import { describe, expect, it } from "vitest";
import { buildHarnessSpawnArgs } from "./harness-lifecycle-helpers-build-harness-spawn-args.js";

describe("buildHarnessSpawnArgs (extracted module)", () => {
	it("builds framed argv with session id and verbose flag", () => {
		expect(buildHarnessSpawnArgs("server.mjs", "/repo", "framed", "session-1", { verbose: true })).toEqual([
			"--max-old-space-size=1536",
			"--expose-gc",
			"server.mjs",
			"--cwd",
			"/repo",
			"--protocol",
			"framed",
			"--session-id",
			"session-1",
			"--verbose",
		]);
	});

	it("omits session id for raw protocol and honors verbose:false", () => {
		expect(buildHarnessSpawnArgs("server.mjs", "/repo", "raw", "ignored", { verbose: false })).toEqual([
			"--max-old-space-size=1536",
			"--expose-gc",
			"server.mjs",
			"--cwd",
			"/repo",
			"--protocol",
			"raw",
		]);
	});
});
