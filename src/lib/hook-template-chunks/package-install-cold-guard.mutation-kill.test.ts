import { expect, it } from "vitest";
import { checkPackageInstallCold } from "./package-install-cold-guard.js";

// test-contract: bug — the cold fallback must refuse installs from every shell tool name a runner uses; a runner that names its shell `run_command` would otherwise install an unvetted package while the daemon is down
it("blocks an install issued through the run_command shell tool", () => {
	const previous = process.env.INTERLINKED_DISABLE_PACKAGE_GUARD;
	delete process.env.INTERLINKED_DISABLE_PACKAGE_GUARD;
	try {
		expect(checkPackageInstallCold("run_command", { command: "npm install left-pad" })).toMatchObject({
			decision: "block",
			rule_id: "supply-chain-inline-fail-closed",
		});
	} finally {
		if (previous !== undefined) process.env.INTERLINKED_DISABLE_PACKAGE_GUARD = previous;
	}
});
