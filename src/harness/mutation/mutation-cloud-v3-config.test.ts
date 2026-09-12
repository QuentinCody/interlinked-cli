// test-contract: boundary — the cloud runtime remains an explicit, strict,
// machine-local opt-in and cannot split authority between its components.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	MAX_MUTATION_CLOUD_V3_CONFIG_BYTES,
	MUTATION_CLOUD_V3_LOCAL_CONFIG,
	buildMutationCloudV3Config,
	checkedPositiveInteger,
	checkedString,
	loadMutationCloudV3Config,
	parseMutationCloudV3Config,
} from "./mutation-cloud-v3-config.js";
import { TEST_REGISTRY } from "./protocol-v3/test-authentication.js";
import { PROTOCOL_V3_CONTRACT_DIGEST } from "./protocol-v3/contract-identity.js";

function validConfig(): Record<string, unknown> {
	return {
		version: 1,
		enabled: true,
		base_url: "https://mutation.example",
		token: "test-credential",
		project_ref: "project-1",
		repository: "github.com/example/repo",
		claimant_id: "installation-1",
		owner: "process-1",
		timeout_ms: 5_000,
		lease_ms: 30_000,
		contract_digest: PROTOCOL_V3_CONTRACT_DIGEST,
		key_registry: TEST_REGISTRY,
		server_authority: { tenant: "tenant-1", project: "project-1" },
		evaluator_policy_version: "policy-v3",
		site_count_threshold: 50,
	};
}

let root = "";
let outside = "";

afterEach(() => {
	if (root !== "") rmSync(root, { recursive: true, force: true });
	if (outside !== "") rmSync(outside, { recursive: true, force: true });
	root = "";
	outside = "";
});

describe("parseMutationCloudV3Config", () => {
	it.each([null, [], 42])("rejects non-object configuration before reading authority fields: %j", (value) => {
		expect(parseMutationCloudV3Config(value, "/repo")).toEqual({ ok: false, reason: "mutation cloud config must be a JSON object" });
	});

	it("rejects an unsupported configuration version", () => {
		expect(parseMutationCloudV3Config({ ...validConfig(), version: 2 }, "/repo")).toEqual({ ok: false, reason: "mutation cloud config version must be 1" });
	});
	it("constructs one submission/client/evaluator authority only after enabled:true", () => {
		const parsed = parseMutationCloudV3Config(validConfig(), "/repo");
		expect(parsed).toMatchObject({
			ok: true,
			config: {
				backgroundEnabled: false,
				submission: {
					projectRef: "project-1",
					repository: "github.com/example/repo",
					contractDigest: PROTOCOL_V3_CONTRACT_DIGEST,
				},
				client: { projectRef: "project-1", claimantId: "installation-1" },
				evaluator: {
					serverAuthority: { tenant: "tenant-1", project: "project-1" },
					cwd: "/repo",
				},
				owner: "process-1",
				leaseMs: 30_000,
			},
		});
	});

	it("requires a separate boolean opt-in for autonomous background processing", () => {
		expect(parseMutationCloudV3Config(validConfig(), "/repo")).toMatchObject({
			ok: true,
			config: { backgroundEnabled: false },
		});
		expect(parseMutationCloudV3Config({ ...validConfig(), background_enabled: true }, "/repo"))
			.toMatchObject({ ok: true, config: { backgroundEnabled: true } });
		expect(parseMutationCloudV3Config({ ...validConfig(), background_enabled: "true" }, "/repo"))
			.toMatchObject({ ok: false, reason: expect.stringContaining("must be a boolean") });
	});

	it("rejects a syntactically valid digest from a different CLI contract", () => {
		expect(
			parseMutationCloudV3Config({ ...validConfig(), contract_digest: "a".repeat(64) }, "/repo"),
		).toMatchObject({ ok: false, reason: expect.stringContaining("does not match this CLI build") });
	});

	it("rejects disabled, unknown-key, split-authority, and insecure remote configurations", () => {
		const disabled = { ...validConfig(), enabled: false };
		expect(parseMutationCloudV3Config(disabled, "/repo")).toMatchObject({
			ok: false,
			reason: expect.stringContaining("not opted in"),
		});
		const unknown = { ...validConfig(), verdict_from_cloud: true };
		expect(parseMutationCloudV3Config(unknown, "/repo")).toMatchObject({
			ok: false,
			reason: expect.stringContaining("unknown key"),
		});
		const split = { ...validConfig(), server_authority: { tenant: "tenant-1", project: "foreign" } };
		expect(parseMutationCloudV3Config(split, "/repo")).toMatchObject({
			ok: false,
			reason: expect.stringContaining("must equal project_ref"),
		});
		const insecure = { ...validConfig(), base_url: "http://mutation.example" };
		expect(parseMutationCloudV3Config(insecure, "/repo")).toMatchObject({
			ok: false,
			reason: expect.stringContaining("HTTPS"),
		});
	});

	it("allows explicit IPv6 loopback HTTP for local integration testing", () => {
		const parsed = parseMutationCloudV3Config({ ...validConfig(), base_url: "http://[::1]:8787" }, "/repo");
		expect(parsed.ok).toBe(true);
	});

	it("rejects a lease too short to fence claim, report, and evaluation stages", () => {
		const parsed = parseMutationCloudV3Config({ ...validConfig(), lease_ms: 14_999 }, "/repo");
		expect(parsed).toMatchObject({ ok: false, reason: expect.stringContaining("3 × timeout_ms") });
	});

	it("requires an explicit immutable repository identity", () => {
		const missing = validConfig();
		delete missing.repository;
		expect(parseMutationCloudV3Config(missing, "/repo")).toMatchObject({
			ok: false,
			reason: expect.stringContaining("repository is required"),
		});
	});

	it("rejects owners that cannot be used as durable lease identifiers", () => {
		for (const owner of ["", "contains spaces", "slash/name", "x".repeat(129)]) {
			expect(parseMutationCloudV3Config({ ...validConfig(), owner }, "/repo")).toMatchObject({
				ok: false,
				reason: expect.stringContaining("owner must be a 1-128 character identifier"),
			});
		}
		expect(parseMutationCloudV3Config({ ...validConfig(), owner: "daemon:pid-42.worker_1" }, "/repo").ok).toBe(true);
	});

	it("allows HTTP only for an explicit loopback development endpoint", () => {
		const local = { ...validConfig(), base_url: "http://127.0.0.1:8787" };
		expect(parseMutationCloudV3Config(local, "/repo").ok).toBe(true);
	});

	it("rejects a base_url that cannot be parsed as a URL at all", () => {
		const parsed = parseMutationCloudV3Config({ ...validConfig(), base_url: "not a url" }, "/repo");
		expect(parsed).toMatchObject({
			ok: false,
			reason: "mutation cloud config base_url must be an absolute URL",
		});
	});

	it("rejects a server_authority missing one of its two required keys", () => {
		const parsed = parseMutationCloudV3Config(
			{ ...validConfig(), server_authority: { tenant: "tenant-1" } },
			"/repo",
		);
		expect(parsed).toMatchObject({
			ok: false,
			reason: "mutation cloud config server_authority must contain exactly tenant and project",
		});
	});

	it("rejects a contract_digest that is not lowercase sha-256 hex", () => {
		const parsed = parseMutationCloudV3Config({ ...validConfig(), contract_digest: "not-a-digest" }, "/repo");
		expect(parsed).toMatchObject({
			ok: false,
			reason: "mutation cloud config contract_digest must be lowercase sha-256 hex",
		});
	});
});

describe("internal parser invariants (unreachable via parseMutationCloudV3Config)", () => {
	// preflightConfigFailure validates every field these three functions read
	// before parseMutationCloudV3Config ever calls them, so the throws below
	// can't be reached through the public entry point. They stay as defensive
	// checks against a future caller that skips preflight; exercised directly.

	it("checkedString throws naming the field once its non-empty-string invariant is violated", () => {
		expect(() => checkedString(42, "widget_name")).toThrow(
			"internal mutation cloud config parser lost checked widget_name",
		);
	});

	it("checkedPositiveInteger throws naming the field once its positive-integer invariant is violated", () => {
		expect(() => checkedPositiveInteger(-3, "widget_count")).toThrow(
			"internal mutation cloud config parser lost checked widget_count",
		);
	});

	it("buildMutationCloudV3Config throws when server_authority was never validated as an object", () => {
		expect(() => buildMutationCloudV3Config({ server_authority: "tenant-1" }, "/repo", false)).toThrow(
			"internal mutation cloud config parser lost checked server_authority",
		);
	});
});

describe("loadMutationCloudV3Config", () => {
	it("keeps the credential-bearing local config out of version control", () => {
		const ignoreRows = readFileSync(join(process.cwd(), ".gitignore"), "utf8").split(/\r?\n/);
		expect(ignoreRows).toContain(MUTATION_CLOUD_V3_LOCAL_CONFIG);
	});

	it("loads the ignored local file and reports malformed JSON with its path", () => {
		root = mkdtempSync(join(tmpdir(), "interlinked-v3-config-"));
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		const path = join(root, ".interlinked", "mutation-cloud-v3.local.json");
		writeFileSync(path, JSON.stringify(validConfig()), "utf8");
		expect(loadMutationCloudV3Config(root)).toMatchObject({ owner: "process-1" });
		writeFileSync(path, "{broken", "utf8");
		expect(() => loadMutationCloudV3Config(root)).toThrow(path);
	});

	it("refuses a config symlink that resolves outside the repository", () => {
		root = mkdtempSync(join(tmpdir(), "interlinked-v3-config-"));
		outside = mkdtempSync(join(tmpdir(), "interlinked-v3-config-outside-"));
		const external = join(outside, "mutation-cloud-v3.local.json");
		writeFileSync(external, JSON.stringify(validConfig()), "utf8");
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		symlinkSync(external, join(root, ".interlinked", "mutation-cloud-v3.local.json"));

		expect(() => loadMutationCloudV3Config(root)).toThrow("must resolve inside the repository root");
	});

	it("refuses a final config symlink even when its target remains inside the repository", () => {
		root = mkdtempSync(join(tmpdir(), "interlinked-v3-config-"));
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		const realConfig = join(root, ".interlinked", "real-config.json");
		writeFileSync(realConfig, JSON.stringify(validConfig()), "utf8");
		symlinkSync("real-config.json", join(root, MUTATION_CLOUD_V3_LOCAL_CONFIG));

		expect(() => loadMutationCloudV3Config(root)).toThrow("must not be a symbolic link");
	});

	it("refuses a local config above the explicit small-file cap", () => {
		root = mkdtempSync(join(tmpdir(), "interlinked-v3-config-"));
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		const path = join(root, MUTATION_CLOUD_V3_LOCAL_CONFIG);
		writeFileSync(path, Buffer.alloc(MAX_MUTATION_CLOUD_V3_CONFIG_BYTES + 1, 0x20));

		expect(() => loadMutationCloudV3Config(root)).toThrow(
			`${MAX_MUTATION_CLOUD_V3_CONFIG_BYTES}-byte local limit`,
		);
	});
});
