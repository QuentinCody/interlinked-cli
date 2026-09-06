// test-contract: public-api — the manual cloud verbs are explicit opt-ins and
// both route through the same durable runtime handle. Most cases inject a
// fake RuntimeHandle; one case (the default-openRuntime test) deliberately
// omits the override so the command's own fallback constructs the real
// MutationCloudV3Runtime against a throwaway temp-dir root, exercising only
// its local (non-network) listDeadLetters path.

import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMutationCloudV3Config } from "../harness/mutation/mutation-cloud-v3-config.js";
import type { MutationCloudV3RuntimeConfig } from "../harness/mutation/mutation-cloud-v3-runtime.js";
import { TEST_REGISTRY } from "../harness/mutation/protocol-v3/test-authentication.js";
import { MAX_TARGET_SOURCE_BYTES } from "../harness/mutation/protocol-v3/field-checks.js";
import { PROTOCOL_V3_CONTRACT_DIGEST } from "../harness/mutation/protocol-v3/contract-identity.js";
import {
	mutationCloudV3DeadLettersCommand,
	mutationCloudV3OnboardCommand,
	mutationCloudV3ProcessCommand,
	mutationCloudV3RedriveCommand,
	mutationCloudV3SubmitEditCommand,
	mutationCloudV3SubmitCommand,
} from "./mutation-cloud-v3.js";

const TARGET = "export const answer = 42;\n";
let temporaryRoot = "";
let outsideRoot = "";

function sha(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function requestText(): string {
	const targetHash = sha(TARGET);
	return JSON.stringify({
		request_version: "1",
		protocol_version: "interlinked-mutation/3.0",
		job: {
			tenant: "tenant-1",
			project: "project-1",
			repository: "github.com/example/interlinked-cli",
			commit: "0123456789abcdef0123456789abcdef01234567",
			target_file: "src/answer.ts",
			target_content_hash: targetHash,
			job_key: "job-command-1",
		},
		source_artifact: {
			format: "git-archive-tar-v1",
			artifact_id: "src_artifact_1",
			sha256: "a".repeat(64),
			bytes: 10,
		},
		scope_mode: "import_graph",
		test_files: ["src/answer.test.ts"],
		changeset: [{ path: "src/answer.ts", content_hash: targetHash }],
	});
}

function runtimeConfig(): MutationCloudV3RuntimeConfig {
	const parsed = parseMutationCloudV3Config({
		version: 1,
		enabled: true,
		base_url: "https://mutation.example",
		token: "test-credential",
		project_ref: "project-1",
		repository: "github.com/example/interlinked-cli",
		claimant_id: "installation-1",
		owner: "process-1",
		timeout_ms: 5_000,
		lease_ms: 30_000,
		contract_digest: PROTOCOL_V3_CONTRACT_DIGEST,
		key_registry: TEST_REGISTRY,
		server_authority: { tenant: "tenant-1", project: "project-1" },
		evaluator_policy_version: "policy-v3",
		site_count_threshold: 50,
	}, "/repo");
	if (!parsed.ok) throw new Error(parsed.reason);
	return parsed.config;
}

beforeEach(() => {
	process.exitCode = undefined;
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	if (temporaryRoot !== "") rmSync(temporaryRoot, { recursive: true, force: true });
	if (outsideRoot !== "") rmSync(outsideRoot, { recursive: true, force: true });
	temporaryRoot = "";
	outsideRoot = "";
	process.exitCode = undefined;
	vi.restoreAllMocks();
});

function writeSubmitFixture(): void {
	mkdirSync(join(temporaryRoot, "src"), { recursive: true });
	writeFileSync(join(temporaryRoot, "request.json"), requestText(), "utf8");
	writeFileSync(join(temporaryRoot, "source.bundle"), "artifact", "utf8");
}

describe("mutationCloudV3OnboardCommand", () => {
	it("forwards only the target and local runtime config, then closes", async () => {
		const close = vi.fn();
		const onboard = vi.fn(async () => ({
			onboarding: {
				kind: "activated" as const,
				jobId: "job_onboard_fixture",
				format: "git-archive-tar-v1" as const,
				preparedReplay: false,
				authenticatedReplay: false,
				activationReplay: false,
			},
			immediate: {
				processor: { kind: "pending" as const, jobId: "job_onboard_fixture" },
				evaluation: null,
			},
		}));
		const readBytes = vi.fn();
		const readText = vi.fn();
		await mutationCloudV3OnboardCommand("src/answer.ts", { cwd: "/repo", json: true }, {
			readBytes,
			readText,
			loadConfig: () => runtimeConfig(),
			openRuntime: () => ({
				onboard,
				submitEdit: vi.fn(),
				submit: vi.fn(),
				processNext: vi.fn(),
				listDeadLetters: vi.fn(),
				redriveDeadLetter: vi.fn(),
				close,
			}),
		});
		expect(onboard).toHaveBeenCalledExactlyOnceWith("src/answer.ts");
		expect(readBytes).not.toHaveBeenCalled();
		expect(readText).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
		expect(process.exitCode).toBeUndefined();
	});

	it("reports capture rejection and still closes the runtime", async () => {
		const close = vi.fn();
		await mutationCloudV3OnboardCommand("src/answer.ts", { cwd: "/repo" }, {
			loadConfig: () => runtimeConfig(),
			openRuntime: () => ({
				onboard: vi.fn(async () => {
					throw new Error("mutation onboarding requires a clean worktree");
				}),
				submitEdit: vi.fn(),
				submit: vi.fn(),
				processNext: vi.fn(),
				listDeadLetters: vi.fn(),
				redriveDeadLetter: vi.fn(),
				close,
			}),
		});
		expect(close).toHaveBeenCalledOnce();
		expect(process.exitCode).toBe(1);
	});

	it("prints a human-readable onboarding line in normal mode", async () => {
		const close = vi.fn();
		const onboard = vi.fn(async () => ({
			onboarding: {
				kind: "activated" as const,
				jobId: "job-onboard-2",
				format: "git-archive-tar-v1" as const,
				preparedReplay: false,
				authenticatedReplay: false,
				activationReplay: false,
			},
			immediate: { processor: { kind: "idle" as const }, evaluation: null },
		}));
		await mutationCloudV3OnboardCommand("src/answer.ts", { cwd: "/repo" }, {
			loadConfig: () => runtimeConfig(),
			openRuntime: () => ({
				onboard,
				submitEdit: vi.fn(),
				submit: vi.fn(),
				processNext: vi.fn(),
				listDeadLetters: vi.fn(),
				redriveDeadLetter: vi.fn(),
				close,
			}),
		});
		expect(console.log).toHaveBeenCalledWith(
			"Mutation onboarding job-onboard-2 activated from immutable HEAD.\nNo durable mutation job is ready.",
		);
		expect(process.exitCode).toBeUndefined();
		expect(close).toHaveBeenCalledOnce();
	});
});

describe("mutationCloudV3SubmitEditCommand", () => {
	it("reads one bounded regular target and delegates exact bytes to the durable runtime", async () => {
		const close = vi.fn();
		const submitEdit = vi.fn(async () => ({
			submission: {
				kind: "enqueued" as const,
				jobId: "job-edit-1",
				remoteJobId: "job-edit-1",
				acceptanceReceiptHash: "c".repeat(64),
				idempotentReplay: false,
				journalReplay: false,
			},
			immediate: { processor: { kind: "pending" as const, jobId: "job-edit-1" }, evaluation: null },
		}));
		const readBytes = vi.fn(() => Buffer.from(TARGET, "utf8"));
		await mutationCloudV3SubmitEditCommand("src/answer.ts", { cwd: "/repo" }, {
			readBytes,
			loadConfig: () => runtimeConfig(),
			openRuntime: () => ({
				onboard: vi.fn(),
				submitEdit,
				submit: vi.fn(),
				processNext: vi.fn(),
				listDeadLetters: vi.fn(),
				redriveDeadLetter: vi.fn(),
				close,
			}),
		});

		expect(readBytes).toHaveBeenCalledExactlyOnceWith({
			root: "/repo",
			path: "/repo/src/answer.ts",
			maxBytes: MAX_TARGET_SOURCE_BYTES,
			label: "mutation per-edit target",
		});
		expect(submitEdit).toHaveBeenCalledWith("src/answer.ts", Buffer.from(TARGET, "utf8"));
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("require_established"));
		expect(close).toHaveBeenCalledOnce();
		expect(process.exitCode).toBeUndefined();
	});

	it("requires an enabled local v3 config before reading source or opening the journal", async () => {
		const readBytes = vi.fn();
		const openRuntime = vi.fn();
		await mutationCloudV3SubmitEditCommand("src/answer.ts", { cwd: "/repo" }, {
			readBytes,
			loadConfig: () => {
				throw new Error("mutation cloud v3 is not opted in");
			},
			openRuntime,
		});

		expect(readBytes).not.toHaveBeenCalled();
		expect(openRuntime).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("not opted in"));
		expect(process.exitCode).toBe(1);
	});

	it("rejects an unsafe target path before config, file, journal, or network work", async () => {
		const loadConfig = vi.fn(() => runtimeConfig());
		const readBytes = vi.fn();
		const openRuntime = vi.fn();
		await mutationCloudV3SubmitEditCommand("../foreign.ts", { cwd: "/repo" }, {
			loadConfig,
			readBytes,
			openRuntime,
		});

		expect(loadConfig).not.toHaveBeenCalled();
		expect(readBytes).not.toHaveBeenCalled();
		expect(openRuntime).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it("rejects even an in-repository target symlink before opening the journal", async () => {
		temporaryRoot = mkdtempSync(join(tmpdir(), "interlinked-v3-edit-command-"));
		mkdirSync(join(temporaryRoot, "src"), { recursive: true });
		writeFileSync(join(temporaryRoot, "src", "real.ts"), TARGET, "utf8");
		symlinkSync("real.ts", join(temporaryRoot, "src", "answer.ts"));
		const openRuntime = vi.fn();

		await mutationCloudV3SubmitEditCommand("src/answer.ts", { cwd: temporaryRoot }, {
			loadConfig: () => runtimeConfig(),
			openRuntime,
		});

		expect(openRuntime).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("symbolic link"));
		expect(process.exitCode).toBe(1);
	});

	it("returns the machine-readable submission result in json mode", async () => {
		const close = vi.fn();
		const submissionResult = {
			submission: {
				kind: "enqueued" as const,
				jobId: "job-edit-2",
				remoteJobId: "job-edit-2",
				acceptanceReceiptHash: "e".repeat(64),
				idempotentReplay: false,
				journalReplay: false,
			},
			immediate: { processor: { kind: "pending" as const, jobId: "job-edit-2" }, evaluation: null },
		};
		const submitEdit = vi.fn(async () => submissionResult);
		await mutationCloudV3SubmitEditCommand("src/answer.ts", { cwd: "/repo", json: true }, {
			readBytes: vi.fn(() => Buffer.from(TARGET, "utf8")),
			loadConfig: () => runtimeConfig(),
			openRuntime: () => ({
				onboard: vi.fn(),
				submitEdit,
				submit: vi.fn(),
				processNext: vi.fn(),
				listDeadLetters: vi.fn(),
				redriveDeadLetter: vi.fn(),
				close,
			}),
		});
		const rendered = String(vi.mocked(console.log).mock.calls[0]?.[0]);
		expect(JSON.parse(rendered)).toEqual(submissionResult);
		expect(close).toHaveBeenCalledOnce();
	});
});

describe("mutationCloudV3SubmitCommand", () => {
	it("reads the request-bound target, submits once, reports pending, and closes", async () => {
		const close = vi.fn();
		const submit = vi.fn(async () => ({
			submission: {
				kind: "enqueued" as const,
				jobId: "job-command-1",
				remoteJobId: "job-command-1",
				acceptanceReceiptHash: "c".repeat(64),
				idempotentReplay: false,
				journalReplay: false,
			},
			immediate: { processor: { kind: "pending" as const, jobId: "job-command-1" }, evaluation: null },
		}));
		const reads: string[] = [];
		await mutationCloudV3SubmitCommand({
			request: "request.json",
			artifact: "source.bundle",
			cwd: "/repo",
			json: true,
		}, {
			readText: () => requestText(),
			readBytes: ({ path }) => {
				reads.push(path);
				return Buffer.from(path.endsWith("answer.ts") ? TARGET : "artifact");
			},
			loadConfig: () => runtimeConfig(),
			openRuntime: () => ({
				onboard: vi.fn(),
				submitEdit: vi.fn(),
				submit,
				processNext: vi.fn(),
				listDeadLetters: vi.fn(),
				redriveDeadLetter: vi.fn(),
				close,
			}),
			clock: () => 100,
		});

		expect(reads).toEqual(["/repo/source.bundle", "/repo/src/answer.ts"]);
		expect(submit).toHaveBeenCalledWith(expect.objectContaining({ createdAtMs: 100 }));
		expect(close).toHaveBeenCalledOnce();
		expect(process.exitCode).toBeUndefined();
	});

	it("rejects malformed request JSON before opening the journal or reading artifacts", async () => {
		const openRuntime = vi.fn();
		const readBytes = vi.fn();
		await mutationCloudV3SubmitCommand({ request: "bad.json", artifact: "source.bundle", cwd: "/repo" }, {
			readText: () => "{bad",
			readBytes,
			loadConfig: () => runtimeConfig(),
			openRuntime,
		});
		expect(openRuntime).not.toHaveBeenCalled();
		expect(readBytes).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it("refuses a target symlink that escapes the repository before opening the journal", async () => {
		temporaryRoot = mkdtempSync(join(tmpdir(), "interlinked-v3-command-"));
		outsideRoot = mkdtempSync(join(tmpdir(), "interlinked-v3-command-outside-"));
		writeSubmitFixture();
		const external = join(outsideRoot, "answer.ts");
		writeFileSync(external, TARGET, "utf8");
		symlinkSync(external, join(temporaryRoot, "src", "answer.ts"));
		const openRuntime = vi.fn();

		await mutationCloudV3SubmitCommand({
			request: "request.json",
			artifact: "source.bundle",
			cwd: temporaryRoot,
		}, { loadConfig: () => runtimeConfig(), openRuntime });

		expect(openRuntime).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("inside the repository root"));
	});

	it("refuses an oversized target before reading it or opening the journal", async () => {
		temporaryRoot = mkdtempSync(join(tmpdir(), "interlinked-v3-command-"));
		writeSubmitFixture();
		mkdirSync(join(temporaryRoot, "src"), { recursive: true });
		writeFileSync(join(temporaryRoot, "src", "answer.ts"), Buffer.alloc(MAX_TARGET_SOURCE_BYTES + 1));
		const openRuntime = vi.fn();

		await mutationCloudV3SubmitCommand({
			request: "request.json",
			artifact: "source.bundle",
			cwd: temporaryRoot,
		}, { loadConfig: () => runtimeConfig(), openRuntime });

		expect(openRuntime).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`${MAX_TARGET_SOURCE_BYTES}-byte`));
	});

	it("prints a human-readable submission line in normal mode", async () => {
		const close = vi.fn();
		const submit = vi.fn(async () => ({
			submission: {
				kind: "enqueued" as const,
				jobId: "job-command-2",
				remoteJobId: "job-command-2",
				acceptanceReceiptHash: "c".repeat(64),
				idempotentReplay: false,
				journalReplay: false,
			},
			immediate: { processor: { kind: "pending" as const, jobId: "job-command-2" }, evaluation: null },
		}));
		await mutationCloudV3SubmitCommand({
			request: "request.json",
			artifact: "source.bundle",
			cwd: "/repo",
		}, {
			readText: () => requestText(),
			readBytes: ({ path }) => Buffer.from(path.endsWith("answer.ts") ? TARGET : "artifact"),
			loadConfig: () => runtimeConfig(),
			openRuntime: () => ({
				onboard: vi.fn(),
				submitEdit: vi.fn(),
				submit,
				processNext: vi.fn(),
				listDeadLetters: vi.fn(),
				redriveDeadLetter: vi.fn(),
				close,
			}),
		});
		expect(console.log).toHaveBeenCalledWith(
			"Mutation job job-command-2 is accepted and still pending.\nSubmission: job-command-2",
		);
		expect(process.exitCode).toBeUndefined();
		expect(close).toHaveBeenCalledOnce();
	});
});

describe("mutationCloudV3ProcessCommand", () => {
	it("surfaces a committed retry honestly and always closes the runtime", async () => {
		const close = vi.fn();
		const processNext = vi.fn(async () => ({
			processor: {
				kind: "retry" as const,
				jobId: "job-command-1",
				stage: "remote_ack" as const,
				reason: "injected outage",
			},
			evaluation: {
				jobId: "job-command-1",
				acceptanceReceiptHash: "a".repeat(64),
				resultHash: "b".repeat(64),
				authenticatedEvidenceHash: "c".repeat(64),
				evaluatorPolicyVersion: "policy-v3",
				evaluation: {},
				decision: { verdict: "adverse" },
				manifestSnapshot: {},
				manifestBaseVersion: 0,
				manifestCommittedVersion: 1,
				manifestSnapshotHash: "d".repeat(64),
				receipt: {},
				runRow: {},
				findings: [{
					findingId: "finding-command-1",
					payload: { message: "Authenticated mutation evidence remains not measured." },
				}],
			},
		}));
		await mutationCloudV3ProcessCommand({ cwd: "/repo" }, {
		loadConfig: () => runtimeConfig(),
		openRuntime: () => ({
			onboard: vi.fn(),
			submitEdit: vi.fn(),
			submit: vi.fn(),
			processNext,
				listDeadLetters: vi.fn(),
				redriveDeadLetter: vi.fn(),
				close,
			}),
		});
		expect(processNext).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
		expect(process.exitCode).toBe(1);
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("remains durable for retry"));
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("local verdict: adverse"));
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Authenticated mutation evidence"));
	});

	it("reports a dead-letter as terminally unmeasured instead of promising another retry", async () => {
		const close = vi.fn();
		await mutationCloudV3ProcessCommand({ cwd: "/repo" }, {
		loadConfig: () => runtimeConfig(),
		openRuntime: () => ({
			onboard: vi.fn(),
			submitEdit: vi.fn(),
			submit: vi.fn(),
			processNext: vi.fn(async () => ({
					processor: {
						kind: "dead_letter" as const,
						jobId: "job-command-1",
						stage: "parse" as const,
						reason: "malformed terminal evidence",
						failureCount: 8,
					},
					evaluation: null,
				})),
				listDeadLetters: vi.fn(),
				redriveDeadLetter: vi.fn(),
				close,
			}),
		});
		expect(process.exitCode).toBe(1);
		expect(close).toHaveBeenCalledOnce();
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("dead-lettered after 8 failures"));
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("no clean verdict exists"));
		expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("durable for retry"));
	});

	it("reports an acknowledged job as journaled before remote acknowledgement", async () => {
		const close = vi.fn();
		await mutationCloudV3ProcessCommand({ cwd: "/repo" }, {
			loadConfig: () => runtimeConfig(),
			openRuntime: () => ({
				onboard: vi.fn(),
				submitEdit: vi.fn(),
				submit: vi.fn(),
				processNext: vi.fn(async () => ({
					processor: { kind: "acknowledged" as const, jobId: "job-ack-1", phase: "poll" as const },
					evaluation: null,
				})),
				listDeadLetters: vi.fn(),
				redriveDeadLetter: vi.fn(),
				close,
			}),
		});
		expect(console.log).toHaveBeenCalledWith(
			"Mutation job job-ack-1 was journaled before remote acknowledgement.",
		);
		expect(process.exitCode).toBeUndefined();
		expect(close).toHaveBeenCalledOnce();
	});

	it("reports a lost lease honestly instead of a clean verdict", async () => {
		const close = vi.fn();
		await mutationCloudV3ProcessCommand({ cwd: "/repo" }, {
			loadConfig: () => runtimeConfig(),
			openRuntime: () => ({
				onboard: vi.fn(),
				submitEdit: vi.fn(),
				submit: vi.fn(),
				processNext: vi.fn(async () => ({
					processor: { kind: "lost_lease" as const, jobId: "job-lease-1", stage: "commit" as const },
					evaluation: null,
				})),
				listDeadLetters: vi.fn(),
				redriveDeadLetter: vi.fn(),
				close,
			}),
		});
		expect(console.log).toHaveBeenCalledWith(
			"Mutation job job-lease-1 lost its local lease during commit; no clean verdict exists.",
		);
		expect(process.exitCode).toBe(1);
	});

	it("returns the machine-readable process result in json mode", async () => {
		const close = vi.fn();
		const processResult = {
			processor: { kind: "pending" as const, jobId: "job-command-3" },
			evaluation: null,
		};
		await mutationCloudV3ProcessCommand({ cwd: "/repo", json: true }, {
			loadConfig: () => runtimeConfig(),
			openRuntime: () => ({
				onboard: vi.fn(),
				submitEdit: vi.fn(),
				submit: vi.fn(),
				processNext: vi.fn(async () => processResult),
				listDeadLetters: vi.fn(),
				redriveDeadLetter: vi.fn(),
				close,
			}),
		});
		const rendered = String(vi.mocked(console.log).mock.calls[0]?.[0]);
		expect(JSON.parse(rendered)).toEqual(processResult);
		expect(process.exitCode).toBeUndefined();
	});

	it("reports a processing exception through outputError and still closes the runtime", async () => {
		const close = vi.fn();
		await mutationCloudV3ProcessCommand({ cwd: "/repo" }, {
			loadConfig: () => runtimeConfig(),
			openRuntime: () => ({
				onboard: vi.fn(),
				submitEdit: vi.fn(),
				submit: vi.fn(),
				processNext: vi.fn(async () => {
					throw new Error("journal is locked by another owner");
				}),
				listDeadLetters: vi.fn(),
				redriveDeadLetter: vi.fn(),
				close,
			}),
		});
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("journal is locked by another owner"));
		expect(process.exitCode).toBe(1);
		expect(close).toHaveBeenCalledOnce();
	});
});

describe("mutationCloudV3DeadLettersCommand", () => {
	it("lists a bounded snapshot without claiming or processing any job", async () => {
		const close = vi.fn();
		const listDeadLetters = vi.fn(() => [{
			jobId: "job-dead-1",
			phase: "ack" as const,
			failureCount: 8,
			lastError: "remote_ack: injected outage",
			deadLetteredAtMs: 500,
			redriveToken: "redrive-token-1",
		}]);
		await mutationCloudV3DeadLettersCommand({ cwd: "/repo", limit: "7", json: true }, {
			loadConfig: () => runtimeConfig(),
			openRuntime: () => ({
				onboard: vi.fn(),
				submitEdit: vi.fn(),
				submit: vi.fn(),
				processNext: vi.fn(),
				listDeadLetters,
				redriveDeadLetter: vi.fn(),
				close,
			}),
		});

		expect(listDeadLetters).toHaveBeenCalledWith(7);
		expect(close).toHaveBeenCalledOnce();
		expect(process.exitCode).toBeUndefined();
		const rendered = String(vi.mocked(console.log).mock.calls[0]?.[0]);
		expect(JSON.parse(rendered)).toEqual({
			limit: 7,
			deadLetters: [{
				jobId: "job-dead-1",
				phase: "ack",
				failureCount: 8,
				lastError: "remote_ack: injected outage",
				deadLetteredAtMs: 500,
				redriveToken: "redrive-token-1",
			}],
		});
		expect(rendered).not.toContain("verdict");
	});

	it("rejects an out-of-range limit before loading config or opening the journal", async () => {
		const loadConfig = vi.fn(() => runtimeConfig());
		const openRuntime = vi.fn();
		await mutationCloudV3DeadLettersCommand({ cwd: "/repo", limit: "101" }, { loadConfig, openRuntime });

		expect(loadConfig).not.toHaveBeenCalled();
		expect(openRuntime).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("integer from 1 through 100"));
	});

	it("rejects a non-integer-shaped limit that Number() would happily accept", async () => {
		const loadConfig = vi.fn(() => runtimeConfig());
		const openRuntime = vi.fn();
		await mutationCloudV3DeadLettersCommand({ cwd: "/repo", limit: "5.0" }, { loadConfig, openRuntime });

		expect(loadConfig).not.toHaveBeenCalled();
		expect(openRuntime).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("integer from 1 through 100"));
	});

	it("renders a human-readable empty state in normal mode", async () => {
		const close = vi.fn();
		await mutationCloudV3DeadLettersCommand({ cwd: "/repo" }, {
			loadConfig: () => runtimeConfig(),
			openRuntime: () => ({
				onboard: vi.fn(),
				submitEdit: vi.fn(),
				submit: vi.fn(),
				processNext: vi.fn(),
				listDeadLetters: vi.fn(() => []),
				redriveDeadLetter: vi.fn(),
				close,
			}),
		});
		expect(console.log).toHaveBeenCalledWith("No mutation cloud job dead letters.");
		expect(close).toHaveBeenCalledOnce();
	});

	it("renders one dead-letter row with a whitespace-compacted last_error in normal mode", async () => {
		const close = vi.fn();
		const listDeadLetters = vi.fn(() => [{
			jobId: "job-dead-2",
			phase: "ack" as const,
			failureCount: 3,
			lastError: "malformed   payload\nline two",
			deadLetteredAtMs: 900,
			redriveToken: "redrive-token-2",
		}]);
		await mutationCloudV3DeadLettersCommand({ cwd: "/repo" }, {
			loadConfig: () => runtimeConfig(),
			openRuntime: () => ({
				onboard: vi.fn(),
				submitEdit: vi.fn(),
				submit: vi.fn(),
				processNext: vi.fn(),
				listDeadLetters,
				redriveDeadLetter: vi.fn(),
				close,
			}),
		});
		expect(console.log).toHaveBeenCalledWith([
			"Mutation cloud job dead letters (1):",
			"job-dead-2  phase=ack  failures=3  dead_lettered_at_ms=900",
			"  redrive_token=redrive-token-2",
			"  last_error=malformed payload line two",
		].join("\n"));
		expect(close).toHaveBeenCalledOnce();
	});

	it("falls back to constructing the real runtime when no openRuntime override is given", async () => {
		temporaryRoot = mkdtempSync(join(tmpdir(), "interlinked-v3-default-runtime-"));
		await mutationCloudV3DeadLettersCommand({ cwd: temporaryRoot, json: true }, {
			loadConfig: () => runtimeConfig(),
		});
		expect(process.exitCode).toBeUndefined();
		const rendered = String(vi.mocked(console.log).mock.calls[0]?.[0]);
		expect(JSON.parse(rendered)).toEqual({ limit: 20, deadLetters: [] });
	});
});

describe("mutationCloudV3RedriveCommand", () => {
	it("uses the fencing token and reports only that the row is due", async () => {
		const close = vi.fn();
		const redriveDeadLetter = vi.fn(() => ({
			kind: "redriven" as const,
			jobId: "job-dead-1",
			dueAtMs: 700,
		}));
		await mutationCloudV3RedriveCommand("job-dead-1", {
			cwd: "/repo",
			redriveToken: "redrive-token-1",
			json: true,
		}, {
		loadConfig: () => runtimeConfig(),
		openRuntime: () => ({
			onboard: vi.fn(),
			submitEdit: vi.fn(),
			submit: vi.fn(),
			processNext: vi.fn(),
			listDeadLetters: vi.fn(),
			redriveDeadLetter,
				close,
			}),
		});

		expect(redriveDeadLetter).toHaveBeenCalledWith("job-dead-1", "redrive-token-1");
		expect(close).toHaveBeenCalledOnce();
		const rendered = String(vi.mocked(console.log).mock.calls[0]?.[0]);
		expect(JSON.parse(rendered)).toEqual({ kind: "redriven", jobId: "job-dead-1", dueAtMs: 700 });
		expect(rendered).not.toMatch(/verdict|decision|evaluation/);
	});

	it("fails closed on a stale token and leaves no success output", async () => {
		const close = vi.fn();
		await mutationCloudV3RedriveCommand("job-dead-1", {
			cwd: "/repo",
			redriveToken: "stale-token",
		}, {
		loadConfig: () => runtimeConfig(),
		openRuntime: () => ({
			onboard: vi.fn(),
			submitEdit: vi.fn(),
			submit: vi.fn(),
			processNext: vi.fn(),
				listDeadLetters: vi.fn(),
				redriveDeadLetter: vi.fn(() => {
					throw new Error("mutation cloud dead letter was not found or its redrive token is stale");
				}),
				close,
			}),
		});

		expect(close).toHaveBeenCalledOnce();
		expect(process.exitCode).toBe(1);
		expect(console.log).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("redrive token is stale"));
	});

	it("prints a human-readable redrive confirmation in normal mode", async () => {
		const close = vi.fn();
		const redriveDeadLetter = vi.fn(() => ({
			kind: "redriven" as const,
			jobId: "job-dead-3",
			dueAtMs: 950,
		}));
		await mutationCloudV3RedriveCommand("job-dead-3", {
			cwd: "/repo",
			redriveToken: "redrive-token-3",
		}, {
			loadConfig: () => runtimeConfig(),
			openRuntime: () => ({
				onboard: vi.fn(),
				submitEdit: vi.fn(),
				submit: vi.fn(),
				processNext: vi.fn(),
				listDeadLetters: vi.fn(),
				redriveDeadLetter,
				close,
			}),
		});
		expect(console.log).toHaveBeenCalledWith(
			"Mutation job job-dead-3 was redriven and is due for processing; no job was processed.",
		);
		expect(close).toHaveBeenCalledOnce();
	});
});
