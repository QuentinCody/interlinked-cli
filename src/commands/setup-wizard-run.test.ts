// Companion for setup-wizard-run.ts — the prompt/wiring layer. The pure
// decision flow is pinned in setup-wizard.test.ts; here we pin what this
// layer owns: the real-deps wiring shape and the non-interactive env mapping.
// The readline prompt loop itself is exercised manually (it is I/O glue over
// the tested applyWizardChoices path).

import { describe, expect, it, vi } from "vitest";

vi.mock("./adopt.js", () => ({ adoptCommand: vi.fn(async () => {}) }));
vi.mock("./caps.js", () => ({ capsSetAction: vi.fn(async () => 0) }));
vi.mock("./enable.js", () => ({ enableCommand: vi.fn(async () => {}) }));
vi.mock("./mode.js", () => ({ modeCommand: vi.fn(async () => {}) }));

import { adoptCommand } from "./adopt.js";
import { capsSetAction } from "./caps.js";
import { enableCommand } from "./enable.js";
import { modeCommand } from "./mode.js";
import { realWizardDeps, runSetupWizardNonInteractive } from "./setup-wizard-run.js";

describe("realWizardDeps — positive (must wire to the owning commands)", () => {
	// test-contract: public-api — each wizard step routes to the command that owns that decision, with the wizard's no-double-confirm mode flag
	it("P1: applyMode forwards to modeCommand with force (plan already confirmed once)", async () => {
		await realWizardDeps().applyMode("strict");
		expect(vi.mocked(modeCommand).mock.calls[0]?.[0]).toBe("strict");
		expect(vi.mocked(modeCommand).mock.calls[0]?.[1]).toMatchObject({ force: true });
	});

	// test-contract: public-api — setCap stringifies through the caps command (its CLI signature), not a private writer
	it("P2: setCap routes through capsSetAction with a string value", async () => {
		await realWizardDeps().setCap("cyclomatic", 15);
		expect(vi.mocked(capsSetAction).mock.calls[0]?.[0]).toBe("cyclomatic");
		expect(vi.mocked(capsSetAction).mock.calls[0]?.[1]).toBe("15");
	});
});

describe("runSetupWizardNonInteractive — positive/negative", () => {
	// test-contract: public-api — env vars drive the bootstrap: clients + sync mode reach enable, adopt honors its flag
	it("P3: INTERLINKED_* env maps into the applied choices", async () => {
		vi.mocked(enableCommand).mockClear();
		vi.mocked(adoptCommand).mockClear();
		await runSetupWizardNonInteractive(
			{ INTERLINKED_CLIENTS: "claude,codex", INTERLINKED_ADOPT: "false" },
			"/repo",
		);
		expect(vi.mocked(enableCommand).mock.calls[0]?.[0]).toMatchObject({
			clients: "claude,codex",
			syncMode: "local",
		});
		expect(vi.mocked(adoptCommand)).not.toHaveBeenCalled();
	});

	// test-contract: boundary — an empty environment still bootstraps with the local-first defaults and never throws
	it("N1: empty env bootstraps with defaults (local sync, adopt on)", async () => {
		vi.mocked(enableCommand).mockClear();
		vi.mocked(adoptCommand).mockClear();
		await runSetupWizardNonInteractive({}, "/repo");
		expect(vi.mocked(enableCommand).mock.calls[0]?.[0]).toMatchObject({ syncMode: "local" });
		expect(vi.mocked(adoptCommand)).toHaveBeenCalledTimes(1);
	});
});
