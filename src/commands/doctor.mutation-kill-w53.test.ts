import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================
// Mocks for every dependency doctorCommand pulls in.
// Each mock is a vi.fn so call args / return values are controllable per test.
// ===========================================

const getClientMock = vi.fn();
vi.mock("../lib/api-client.js", () => ({
	getClient: () => getClientMock(),
}));

// Fixture isolation: the drift check reads the REAL repo's installer
// manifest when unmocked (these tests run with the repo as cwd), which
// shifted the pass counts this suite pins.
vi.mock("./doctor-install-drift.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./doctor-install-drift.js")>()),
	installedHookDriftChecks: () => [],
}));
vi.mock("./doctor-posture.js", () => ({
	postureEnumChecks: () => [],
}));

const resolveAuthTokenMock = vi.fn();
vi.mock("../lib/auth.js", () => ({
	resolveAuthToken: (cwd: string) => resolveAuthTokenMock(cwd),
}));

const getCollectionLivenessMock = vi.fn();
vi.mock("../lib/collection/liveness.js", () => ({
	getCollectionLiveness: (cwd: string) => getCollectionLivenessMock(cwd),
}));

const resolveConfigMock = vi.fn();
const getConfigDirMock = vi.fn();
vi.mock("../lib/config.js", () => ({
	resolveConfig: (cwd: string) => resolveConfigMock(cwd),
	getConfigDir: (cwd: string) => getConfigDirMock(cwd),
}));

vi.mock("../lib/formatter.js", () => ({
	c: {
		green: (s: string) => s,
		red: (s: string) => s,
		yellow: (s: string) => s,
		dim: (s: string) => s,
	},
	divider: () => "----DIVIDER----",
	header: (s: string) => `## ${s}`,
}));

const adoptionArtifactChecksMock = vi.fn();
vi.mock("./adopt.js", () => ({
	adoptionArtifactChecks: (cwd: string) => adoptionArtifactChecksMock(cwd),
}));

const thinkingCaptureCheckMock = vi.fn();
// Keep this summary-rendering fixture's check list explicit. Real producer
// coverage is exercised against temporary directories in doctor-data.test.ts.
vi.mock("./doctor-data.js", () => ({
	captureChecks: (cwd: string) => [thinkingCaptureCheckMock(cwd)],
}));

const authTokenCheckMock = vi.fn();
const clientHookChecksMock = vi.fn();
const collectionLivenessCheckMock = vi.fn();
const harnessChecksMock = vi.fn();
const hookVersionChecksMock = vi.fn();
const legacyConfigCheckMock = vi.fn();
const localFileChecksMock = vi.fn();
const metricCapsConfigCheckMock = vi.fn();
const permissionRuleChecksMock = vi.fn();
const sessionFileChecksMock = vi.fn();
const systemChecksMock = vi.fn();
vi.mock("./doctor-checks.js", () => ({
	authTokenCheck: (...a: unknown[]) => authTokenCheckMock(...a),
	clientHookChecks: (...a: unknown[]) => clientHookChecksMock(...a),
	collectionLivenessCheck: (...a: unknown[]) => collectionLivenessCheckMock(...a),
	harnessChecks: (...a: unknown[]) => harnessChecksMock(...a),
	hookVersionChecks: (...a: unknown[]) => hookVersionChecksMock(...a),
	legacyConfigCheck: (...a: unknown[]) => legacyConfigCheckMock(...a),
	localFileChecks: (...a: unknown[]) => localFileChecksMock(...a),
	metricCapsConfigCheck: (...a: unknown[]) => metricCapsConfigCheckMock(...a),
	permissionRuleChecks: (...a: unknown[]) => permissionRuleChecksMock(...a),
	sessionFileChecks: (...a: unknown[]) => sessionFileChecksMock(...a),
	statusIcon: (status: string) => `[${status}]`,
	systemChecks: () => systemChecksMock(),
}));

const skillInstallationChecksMock = vi.fn();
vi.mock("./doctor-skills.js", () => ({
	skillInstallationChecks: (...a: unknown[]) => skillInstallationChecksMock(...a),
}));

const probeHarnessLiveMock = vi.fn();
vi.mock("./harness-liveness.js", () => ({
	probeHarnessLive: (...a: unknown[]) => probeHarnessLiveMock(...a),
}));

const isHarnessRunningMock = vi.fn();
vi.mock("./harness.js", () => ({
	isHarnessRunning: (...a: unknown[]) => isHarnessRunningMock(...a),
}));

import { doctorCommand } from "./doctor.js";

function resetAllMocksToBenignDefaults(): void {
	getClientMock.mockReset();
	resolveAuthTokenMock.mockReset().mockReturnValue(null);
	getCollectionLivenessMock.mockReset().mockReturnValue({});
	resolveConfigMock.mockReset().mockReturnValue({ server_url: "https://example.test" });
	getConfigDirMock.mockReset().mockReturnValue("/tmp/config-dir");
	adoptionArtifactChecksMock.mockReset().mockReturnValue([]);
	thinkingCaptureCheckMock
		.mockReset()
		.mockReturnValue({ name: "Thinking capture", status: "pass", message: "ok" });
	authTokenCheckMock
		.mockReset()
		.mockReturnValue({ name: "Auth token", status: "pass", message: "ok" });
	clientHookChecksMock.mockReset().mockReturnValue([]);
	collectionLivenessCheckMock.mockReset().mockReturnValue({ status: "pass", message: "ok" });
	harnessChecksMock.mockReset().mockReturnValue([]);
	hookVersionChecksMock.mockReset().mockReturnValue([]);
	legacyConfigCheckMock.mockReset().mockReturnValue([]);
	localFileChecksMock.mockReset().mockReturnValue([]);
	metricCapsConfigCheckMock
		.mockReset()
		.mockReturnValue({ name: "Metric caps config", status: "pass", message: "ok" });
	permissionRuleChecksMock.mockReset().mockReturnValue([]);
	sessionFileChecksMock.mockReset().mockReturnValue([]);
	systemChecksMock.mockReset().mockReturnValue([]);
	skillInstallationChecksMock.mockReset().mockReturnValue([]);
	probeHarnessLiveMock.mockReset().mockResolvedValue(false);
	isHarnessRunningMock.mockReset().mockReturnValue({ running: false });
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	resetAllMocksToBenignDefaults();
	logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
	logSpy.mockRestore();
	vi.clearAllMocks();
});

function lastJsonPayload(): any {
	const call = logSpy.mock.calls[logSpy.mock.calls.length - 1];
	return JSON.parse(call?.[0] as string);
}

function lastNormalText(): string {
	const call = logSpy.mock.calls[logSpy.mock.calls.length - 1];
	return call?.[0] as string;
}

// ===========================================
// opts.fix === true propagation (kills ConditionalExpression true/false,
// EqualityOperator !==, BooleanLiteral true->false mutants for the four
// `opts.fix === true` call sites).
// ===========================================
describe("opts.fix propagation — positive (must fire)", () => {
	it("passes fix=true to every fix-aware check when opts.fix is true", async () => {
		await doctorCommand({ fix: true, json: true });
		expect(hookVersionChecksMock.mock.calls[0]?.[1]).toBe(true);
		expect(skillInstallationChecksMock.mock.calls[0]?.[1]).toBe(true);
		expect(permissionRuleChecksMock.mock.calls[0]?.[1]).toBe(true);
		expect(legacyConfigCheckMock.mock.calls[0]?.[1]).toBe(true);
	});

	it("passes fix=false to every fix-aware check when opts.fix is omitted", async () => {
		await doctorCommand({ json: true });
		expect(hookVersionChecksMock.mock.calls[0]?.[1]).toBe(false);
		expect(skillInstallationChecksMock.mock.calls[0]?.[1]).toBe(false);
		expect(permissionRuleChecksMock.mock.calls[0]?.[1]).toBe(false);
		expect(legacyConfigCheckMock.mock.calls[0]?.[1]).toBe(false);
	});
});

// ===========================================
// Data-collection entry: name + spread of collectionLivenessCheck (kills
// ArrayDeclaration on `results`, ObjectLiteral {} mutant, StringLiteral "".)
// ===========================================
describe("Data collection result entry — positive (must fire)", () => {
	it("pushes a named entry that spreads collectionLivenessCheck's fields", async () => {
		collectionLivenessCheckMock.mockReturnValue({ status: "warn", message: "stalled 5m" });
		await doctorCommand({ json: true });
		const payload = lastJsonPayload();
		const entry = payload.local.find((r: any) => r.name === "Data collection");
		expect(entry).toBeDefined();
		expect(entry.status).toBe("warn");
		expect(entry.message).toBe("stalled 5m");
	});
});

// ===========================================
// json summary counts (kills ArrowFunction->undefined, ConditionalExpression
// true/false, EqualityOperator !==, StringLiteral "pass"->"" for the
// `(r) => r.status === "pass"` filter feeding summary.pass).
// ===========================================
describe("json summary pass/fail/warn counts — positive (must fire)", () => {
	it("counts exactly the pass entries, distinguishable from total and from non-pass", async () => {
		// pass=5, fail=1, warn=2, total=8 (asymmetric so pass != total-pass != total)
		systemChecksMock.mockReturnValue([{ name: "sys", status: "pass", message: "ok" }]);
		localFileChecksMock.mockReturnValue([{ name: "local", status: "fail", message: "bad" }]);
		collectionLivenessCheckMock.mockReturnValue({ status: "pass", message: "ok" });
		thinkingCaptureCheckMock.mockReturnValue({ name: "think", status: "warn", message: "m" });
		authTokenCheckMock.mockReturnValue({ name: "auth", status: "pass", message: "ok" });
		hookVersionChecksMock.mockReturnValue([{ name: "hv", status: "pass", message: "ok" }]);
		resolveAuthTokenMock.mockReturnValue(null); // serverChecks -> single warn entry

		await doctorCommand({ json: true });
		const payload = lastJsonPayload();
		expect(payload.summary.pass).toBe(5);
		expect(payload.summary.fail).toBe(1);
		expect(payload.summary.warn).toBe(2);
		const total = payload.local.length + payload.server.length;
		expect(total).toBe(8);
	});
});

// ===========================================
// Normal-mode rendering (kills header StringLiterals, [] ArrayDeclaration on
// `lines`/`summaryParts`, blank-string StringLiterals, ", "/"\n" join
// separators, failCount>0 ConditionalExpression + EqualityOperator, and the
// MethodExpression that drops `.filter` from the normal-mode passCount).
// ===========================================
describe("normal-mode text rendering — positive (must fire)", () => {
	it("shows section headers and never leaks stryker placeholder text", async () => {
		await doctorCommand({});
		const text = lastNormalText();
		expect(text).toContain("## Local Checks");
		expect(text).toContain("## Server Checks");
		expect(text).not.toContain("Stryker was here");
	});

	it("is multi-line (kills the lines.join('\\n') separator mutant)", async () => {
		await doctorCommand({});
		const text = lastNormalText();
		expect(text.split("\n").length).toBeGreaterThan(5);
	});

	it("displays the filtered pass count, not the total result count", async () => {
		// pass=5, fail=1, warn=2, total=8 — same asymmetric setup as the json test
		systemChecksMock.mockReturnValue([{ name: "sys", status: "pass", message: "ok" }]);
		localFileChecksMock.mockReturnValue([{ name: "local", status: "fail", message: "bad" }]);
		collectionLivenessCheckMock.mockReturnValue({ status: "pass", message: "ok" });
		thinkingCaptureCheckMock.mockReturnValue({ name: "think", status: "warn", message: "m" });
		authTokenCheckMock.mockReturnValue({ name: "auth", status: "pass", message: "ok" });
		hookVersionChecksMock.mockReturnValue([{ name: "hv", status: "pass", message: "ok" }]);
		resolveAuthTokenMock.mockReturnValue(null);

		await doctorCommand({});
		const text = lastNormalText();
		expect(text).toContain("5 passed");
		expect(text).not.toContain("8 passed");
	});

	it("joins summary parts with a comma and a space", async () => {
		systemChecksMock.mockReturnValue([{ name: "sys", status: "pass", message: "ok" }]);
		localFileChecksMock.mockReturnValue([{ name: "local", status: "fail", message: "bad" }]);
		collectionLivenessCheckMock.mockReturnValue({ status: "warn", message: "m" });

		await doctorCommand({});
		const text = lastNormalText();
		expect(text).toMatch(/\d+ passed, \d+ failed, \d+ warnings/);
	});

	it("omits the 'failed' segment entirely when failCount is zero", async () => {
		// Every check reports pass or warn only — no fail entries anywhere.
		systemChecksMock.mockReturnValue([{ name: "sys", status: "pass", message: "ok" }]);
		localFileChecksMock.mockReturnValue([]);
		collectionLivenessCheckMock.mockReturnValue({ status: "pass", message: "ok" });
		thinkingCaptureCheckMock.mockReturnValue({ name: "think", status: "pass", message: "m" });
		authTokenCheckMock.mockReturnValue({ name: "auth", status: "pass", message: "ok" });
		resolveAuthTokenMock.mockReturnValue(null); // adds one warn, never a fail

		await doctorCommand({});
		const text = lastNormalText();
		expect(text).not.toContain("failed");
	});
});

// ===========================================
// Server-path checks: serverIdentityChecks + workspaceAccessChecks
// (kills ArrayDeclaration on both `out` arrays, StringLiteral
// "list_workspaces"->"", OptionalChaining wsResult?.workspaces->wsResult.workspaces)
// ===========================================
describe("server checks — positive (must fire)", () => {
	function makeAuthenticatedClient(callToolImpl: (name: string, args: unknown) => unknown) {
		return {
			healthCheck: vi.fn().mockResolvedValue({ serverReachable: true, authenticated: true }),
			fetchWorkspaces: vi.fn().mockResolvedValue([{ id: "a" }, { id: "b" }]),
			callTool: vi.fn(callToolImpl),
		};
	}

	it("reports exactly 4 server entries with no extra array elements", async () => {
		resolveAuthTokenMock.mockReturnValue("tok-123");
		const client = makeAuthenticatedClient((name: string) => {
			if (name !== "list_workspaces") throw new Error("wrong tool");
			return { workspaces: [{ name: "cb1" }, { name: "cb2" }] };
		});
		getClientMock.mockReturnValue(client);

		await doctorCommand({ json: true });
		const payload = lastJsonPayload();
		expect(payload.server).toHaveLength(4);
		expect(payload.server.map((r: any) => r.name)).toEqual([
			"Server reachable",
			"Auth valid",
			"Registry workspace access",
			"Codebase access (active workspace)",
		]);
	});

	it("calls callTool with the exact tool name 'list_workspaces'", async () => {
		resolveAuthTokenMock.mockReturnValue("tok-123");
		const client = makeAuthenticatedClient((name: string) => {
			if (name !== "list_workspaces") throw new Error("wrong tool name received");
			return { workspaces: [{ name: "cb1" }] };
		});
		getClientMock.mockReturnValue(client);

		await doctorCommand({ json: true });
		const payload = lastJsonPayload();
		const entry = payload.server.find(
			(r: any) => r.name === "Codebase access (active workspace)",
		);
		expect(entry.status).toBe("pass");
		expect(entry.message).toBe("1 codebase(s) in active workspace");
	});

	it("treats a nullish callTool result as zero codebases, not a thrown error", async () => {
		resolveAuthTokenMock.mockReturnValue("tok-123");
		const client = makeAuthenticatedClient(() => undefined);
		getClientMock.mockReturnValue(client);

		await doctorCommand({ json: true });
		const payload = lastJsonPayload();
		const entry = payload.server.find(
			(r: any) => r.name === "Codebase access (active workspace)",
		);
		// wsResult?.workspaces on undefined -> undefined -> codebaseCount 0 -> "warn".
		// Without the optional chain, `wsResult.workspaces` throws and this becomes "fail".
		expect(entry.status).toBe("warn");
		expect(entry.message).toBe("No codebases found in active workspace");
	});
});
