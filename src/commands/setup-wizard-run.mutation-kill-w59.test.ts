import { nonNull } from "../lib/non-null.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture calls to choicesFromNonInteractive while keeping its real logic,
// and stub applyWizardChoices so no real side-effecting commands run.
const applyWizardChoicesMock = vi.fn<typeof import("./setup-wizard.js").applyWizardChoices>(async () => ({ failures: [] }));

vi.mock("./setup-wizard.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./setup-wizard.js")>();
	return {
		...actual,
		choicesFromNonInteractive: vi.fn(actual.choicesFromNonInteractive),
		applyWizardChoices: (...args: Parameters<typeof actual.applyWizardChoices>) =>
			applyWizardChoicesMock(...args),
	};
});

import { choicesFromNonInteractive } from "./setup-wizard.js";
import { runSetupWizardNonInteractive } from "./setup-wizard-run.js";

const choicesFromNonInteractiveMock = vi.mocked(choicesFromNonInteractive);

function loggedIncludes(logSpy: ReturnType<typeof vi.spyOn>, needle: string): boolean {
	return logSpy.mock.calls.some((call: unknown[]) => {
		const first = call[0];
		return typeof first === "string" && first.includes(needle);
	});
}

describe("runSetupWizardNonInteractive — env-driven partial object spreads (positive/negative)", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		applyWizardChoicesMock.mockClear();
		applyWizardChoicesMock.mockResolvedValue({ failures: [] });
		choicesFromNonInteractiveMock.mockClear();
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it("P1: INTERLINKED_MODE set -> mode key present in the spread object", async () => {
		await runSetupWizardNonInteractive({ INTERLINKED_MODE: "strict" }, "/tmp");
		const arg = choicesFromNonInteractiveMock.mock.calls[0]?.[0];
		expect(arg).toHaveProperty("mode", "strict");
	});

	it("N1: INTERLINKED_MODE unset -> mode key absent from the spread object", async () => {
		const env: NodeJS.ProcessEnv = {};
		await runSetupWizardNonInteractive(env, "/tmp");
		const arg = choicesFromNonInteractiveMock.mock.calls[0]?.[0];
		expect(arg).not.toHaveProperty("mode");
	});

	it("P2: INTERLINKED_SCOPE set -> scope key present in the spread object", async () => {
		await runSetupWizardNonInteractive(
			{ INTERLINKED_SCOPE: "whole-file" },
			"/tmp",
		);
		const arg = choicesFromNonInteractiveMock.mock.calls[0]?.[0];
		expect(arg).toHaveProperty("scope", "whole-file");
	});

	it("N2: INTERLINKED_SCOPE unset -> scope key absent from the spread object", async () => {
		const env: NodeJS.ProcessEnv = {};
		await runSetupWizardNonInteractive(env, "/tmp");
		const arg = choicesFromNonInteractiveMock.mock.calls[0]?.[0];
		expect(arg).not.toHaveProperty("scope");
	});

	it("P3: INTERLINKED_ADOPT set -> adopt key present in the spread object", async () => {
		await runSetupWizardNonInteractive({ INTERLINKED_ADOPT: "no" }, "/tmp");
		const arg = choicesFromNonInteractiveMock.mock.calls[0]?.[0];
		expect(arg).toHaveProperty("adopt", "no");
	});

	it("N3: INTERLINKED_ADOPT unset -> adopt key absent from the spread object", async () => {
		const env: NodeJS.ProcessEnv = {};
		await runSetupWizardNonInteractive(env, "/tmp");
		const arg = choicesFromNonInteractiveMock.mock.calls[0]?.[0];
		expect(arg).not.toHaveProperty("adopt");
	});

	it("P4: INTERLINKED_CLIENTS set -> runners key present in the spread object", async () => {
		await runSetupWizardNonInteractive(
			{ INTERLINKED_CLIENTS: "claude,codex" },
			"/tmp",
		);
		const arg = choicesFromNonInteractiveMock.mock.calls[0]?.[0];
		expect(arg).toHaveProperty("runners", "claude,codex");
	});

	it("N4: INTERLINKED_CLIENTS unset -> runners key absent from the spread object", async () => {
		const env: NodeJS.ProcessEnv = {};
		await runSetupWizardNonInteractive(env, "/tmp");
		const arg = choicesFromNonInteractiveMock.mock.calls[0]?.[0];
		expect(arg).not.toHaveProperty("runners");
	});

	it("P5: INTERLINKED_SYNC_MODE set -> syncMode key present in the spread object", async () => {
		await runSetupWizardNonInteractive(
			{ INTERLINKED_SYNC_MODE: "local" },
			"/tmp",
		);
		const arg = choicesFromNonInteractiveMock.mock.calls[0]?.[0];
		expect(arg).toHaveProperty("syncMode", "local");
	});

	it("N5: INTERLINKED_SYNC_MODE unset -> syncMode key absent from the spread object", async () => {
		const env: NodeJS.ProcessEnv = {};
		await runSetupWizardNonInteractive(env, "/tmp");
		const arg = choicesFromNonInteractiveMock.mock.calls[0]?.[0];
		expect(arg).not.toHaveProperty("syncMode");
	});

	it("P6: all five env vars set -> the spread object carries exactly those five keys", async () => {
		await runSetupWizardNonInteractive(
			{
				INTERLINKED_MODE: "strict",
				INTERLINKED_SCOPE: "diff",
				INTERLINKED_ADOPT: "yes",
				INTERLINKED_CLIENTS: "claude",
				INTERLINKED_SYNC_MODE: "realtime",
			},
			"/tmp",
		);
		const arg = choicesFromNonInteractiveMock.mock.calls[0]?.[0];
		expect(Object.keys(nonNull(arg)).sort()).toEqual(
			["adopt", "mode", "runners", "scope", "syncMode"].sort(),
		);
	});

	it("N6: no env vars set -> the spread object carries none of the five keys", async () => {
		const env: NodeJS.ProcessEnv = {};
		await runSetupWizardNonInteractive(env, "/tmp");
		const arg = choicesFromNonInteractiveMock.mock.calls[0]?.[0];
		expect(arg).toEqual({});
	});

	it("P7: prints the exact bootstrapping banner message", async () => {
		await runSetupWizardNonInteractive({}, "/tmp");
		expect(
			loggedIncludes(
				logSpy,
				"[interlinked] No config found. Bootstrapping (local-first defaults)…",
			),
		).toBe(true);
	});

	it("P8: prints the exact per-failure step-failed message including the failure text", async () => {
		applyWizardChoicesMock.mockResolvedValueOnce({ failures: ["boom-step"] });
		await runSetupWizardNonInteractive({}, "/tmp");
		expect(loggedIncludes(logSpy, "[interlinked] step failed (re-runnable): boom-step")).toBe(true);
	});

	it("N8: prints nothing about a step failing when there are no failures", async () => {
		applyWizardChoicesMock.mockResolvedValueOnce({ failures: [] });
		await runSetupWizardNonInteractive({}, "/tmp");
		expect(loggedIncludes(logSpy, "step failed")).toBe(false);
	});
});
