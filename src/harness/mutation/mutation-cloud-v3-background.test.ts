import { describe, expect, it, vi } from "vitest";
import type { MutationCloudV3ProcessResult, MutationCloudV3RuntimeConfig } from "./mutation-cloud-v3-runtime.js";
import { TEST_REGISTRY } from "./protocol-v3/test-authentication.js";
import { PROTOCOL_V3_CONTRACT_DIGEST } from "./protocol-v3/contract-identity.js";
import type { MutationFindingDeliveryOutcome } from "./mutation-cloud-v3-finding-delivery.js";
import { startMutationCloudV3Background } from "./mutation-cloud-v3-background.js";

const IDLE: MutationCloudV3ProcessResult = {
	processor: { kind: "idle" },
	evaluation: null,
};

function runtimeConfig(): MutationCloudV3RuntimeConfig {
	const serverAuthority = { tenant: "test-tenant", project: "test-project" };
	return {
		submission: {
			baseUrl: "https://mutation.example", token: "test-credential", projectRef: "test-project",
			repository: "test-repository", timeoutMs: 5_000, contractDigest: PROTOCOL_V3_CONTRACT_DIGEST,
			keyRegistry: TEST_REGISTRY, serverAuthority,
		},
		client: {
			baseUrl: "https://mutation.example", token: "test-credential", projectRef: "test-project",
			claimantId: "test-installation", timeoutMs: 5_000,
		},
		evaluator: { keyRegistry: TEST_REGISTRY, serverAuthority, evaluatorPolicyVersion: "test-policy", siteCountThreshold: 50 },
		owner: "test-owner", leaseMs: 15_000,
	};
}

function dependencies(overrides: {
	exists?: boolean;
	backgroundEnabled?: boolean;
	processNext?: () => Promise<MutationCloudV3ProcessResult>;
	deliverOneFinding?: () => Promise<MutationFindingDeliveryOutcome>;
} = {}) {
	const close = vi.fn();
	const processNext = vi.fn(overrides.processNext ?? (async () => IDLE));
	const deliverOneFinding = vi.fn(overrides.deliverOneFinding ?? (async () => ({ kind: "idle" as const })));
	const openRuntime = vi.fn(() => ({ processNext, deliverOneFinding, close }));
	return {
		close,
		processNext,
		deliverOneFinding,
		openRuntime,
		configExists: vi.fn(() => overrides.exists ?? true),
		loadConfig: vi.fn(() => ({ ...runtimeConfig(), backgroundEnabled: overrides.backgroundEnabled ?? true })),
	};
}

describe("mutation cloud v3 background scheduler", () => {
	it("stays silent and never opens a runtime when the opt-in file is absent", async () => {
		const deps = dependencies({ exists: false });
		const log = vi.fn();
		const background = startMutationCloudV3Background(
			{ root: "/repo", log, intervalMs: 60_000 },
			deps,
		);

		expect(await background.tick()).toBe("disabled");
		expect(deps.openRuntime).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
		background.stop();
	});

	it("keeps an enabled manual config autonomous-off without the separate background opt-in", async () => {
		const deps = dependencies({ backgroundEnabled: false });
		const log = vi.fn();
		const background = startMutationCloudV3Background(
			{ root: "/repo", log, intervalMs: 60_000 },
			deps,
		);

		expect(await background.tick()).toBe("disabled");
		expect(deps.loadConfig).toHaveBeenCalledTimes(1);
		expect(deps.openRuntime).not.toHaveBeenCalled();
		expect(deps.processNext).not.toHaveBeenCalled();
		expect(deps.deliverOneFinding).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
		background.stop();
	});

	it("processes one due job through the shared runtime and always closes it", async () => {
		const acknowledged: MutationCloudV3ProcessResult = {
			processor: { kind: "acknowledged", jobId: "job-1", phase: "poll" },
			evaluation: null,
		};
		const deps = dependencies({ processNext: async () => acknowledged });
		const onResult = vi.fn();
		const log = vi.fn();
		const background = startMutationCloudV3Background(
			{ root: "/repo", log, onResult, intervalMs: 60_000 },
			deps,
		);

		expect(await background.tick()).toBe("processed");
		expect(deps.processNext).toHaveBeenCalledTimes(1);
		expect(deps.deliverOneFinding).toHaveBeenCalledTimes(1);
		expect(deps.close).toHaveBeenCalledTimes(1);
		expect(onResult).toHaveBeenCalledWith(acknowledged);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("journaled and acknowledged"));
		background.stop();
	});

	it("delivers a committed finding even when remote result processing fails", async () => {
		const delivered = {
			kind: "delivered" as const,
			outboxId: `1:${"a".repeat(64)}`,
			message: "[interlinked:mutation] adverse result",
		};
		const deps = dependencies({
			processNext: async () => {
				throw new Error("remote unavailable");
			},
			deliverOneFinding: async () => delivered,
		});
		const onFinding = vi.fn();
		const background = startMutationCloudV3Background(
			{ root: "/repo", log: vi.fn(), onFinding, intervalMs: 60_000 },
			deps,
		);

		expect(await background.tick()).toBe("failed");
		expect(onFinding).toHaveBeenCalledWith(delivered);
		expect(deps.deliverOneFinding).toHaveBeenCalledTimes(1);
		expect(deps.close).toHaveBeenCalledTimes(1);
		background.stop();
	});

	it("counts finding-only delivery as processed and surfaces it through the callback", async () => {
		const delivered = {
			kind: "delivered" as const,
			outboxId: `1:${"b".repeat(64)}`,
			message: "[interlinked:mutation] baseline adopted",
		};
		const deps = dependencies({ deliverOneFinding: async () => delivered });
		const onFinding = vi.fn();
		const background = startMutationCloudV3Background(
			{ root: "/repo", log: vi.fn(), onFinding, intervalMs: 60_000 },
			deps,
		);

		expect(await background.tick()).toBe("processed");
		expect(onFinding).toHaveBeenCalledWith(delivered);
		background.stop();
	});

	it("does not overlap slow ticks and resumes after the first tick settles", async () => {
		let settle: ((value: MutationCloudV3ProcessResult) => void) | undefined;
		let calls = 0;
		const deps = dependencies({
			processNext: () => {
				calls += 1;
				if (calls > 1) return Promise.resolve(IDLE);
				return new Promise((resolve) => {
					settle = resolve;
				});
			},
		});
		const background = startMutationCloudV3Background(
			{ root: "/repo", log: vi.fn(), intervalMs: 60_000 },
			deps,
		);

		const first = background.tick();
		await vi.waitFor(() => expect(deps.processNext).toHaveBeenCalledTimes(1));
		expect(await background.tick()).toBe("busy");
		settle?.(IDLE);
		expect(await first).toBe("idle");
		await vi.waitFor(() => expect(deps.close).toHaveBeenCalledTimes(1));
		expect(await background.tick()).toBe("idle");
		expect(deps.processNext).toHaveBeenCalledTimes(2);
		background.stop();
	});

	it("deduplicates repeated failures without suppressing a later distinct failure", async () => {
		const deps = dependencies();
		deps.loadConfig
			.mockImplementationOnce(() => { throw new Error("bad config"); })
			.mockImplementationOnce(() => { throw new Error("bad config"); })
			.mockImplementationOnce(() => { throw new Error("network unavailable"); });
		const log = vi.fn();
		const background = startMutationCloudV3Background(
			{ root: "/repo", log, intervalMs: 60_000 },
			deps,
		);

		expect(await background.tick()).toBe("failed");
		expect(log).toHaveBeenCalledTimes(1);
		expect(await background.tick()).toBe("failed");
		expect(log).toHaveBeenCalledTimes(1);
		expect(await background.tick()).toBe("failed");
		expect(log).toHaveBeenCalledTimes(2);
		background.stop();
	});

	it("stops future work and rejects sub-second polling intervals", async () => {
		const deps = dependencies({ exists: false });
		const background = startMutationCloudV3Background(
			{ root: "/repo", log: vi.fn(), intervalMs: 1_000 },
			deps,
		);
		background.stop();
		expect(await background.tick()).toBe("disabled");
		expect(() => startMutationCloudV3Background({
			root: "/repo",
			log: vi.fn(),
			intervalMs: 999,
		}, deps)).toThrow("at least 1000ms");
	});

	it("reports a dead-lettered job by name, stage, and reason", async () => {
		const deadLetter: MutationCloudV3ProcessResult = {
			processor: { kind: "dead_letter", jobId: "job-9", stage: "poll", reason: "manifest checksum mismatch", failureCount: 3 },
			evaluation: null,
		};
		const deps = dependencies({ processNext: async () => deadLetter });
		const log = vi.fn();
		const background = startMutationCloudV3Background(
			{ root: "/repo", log, intervalMs: 60_000 },
			deps,
		);

		expect(await background.tick()).toBe("processed");
		expect(log).toHaveBeenCalledWith(
			"Mutation cloud background job job-9 was dead-lettered during poll: manifest checksum mismatch",
		);
		background.stop();
	});

	it("reports a job that lost its local lease mid-cycle", async () => {
		const lostLease: MutationCloudV3ProcessResult = {
			processor: { kind: "lost_lease", jobId: "job-7", stage: "journal_ack" },
			evaluation: null,
		};
		const deps = dependencies({ processNext: async () => lostLease });
		const log = vi.fn();
		const background = startMutationCloudV3Background(
			{ root: "/repo", log, intervalMs: 60_000 },
			deps,
		);

		expect(await background.tick()).toBe("processed");
		expect(log).toHaveBeenCalledWith(
			"Mutation cloud background job job-7 lost its local lease during journal_ack; it was not treated as clean.",
		);
		background.stop();
	});

	it("reports a job scheduled for retry with its stage and reason", async () => {
		const retry: MutationCloudV3ProcessResult = {
			processor: { kind: "retry", jobId: "job-3", stage: "poll", reason: "remote timeout" },
			evaluation: null,
		};
		const deps = dependencies({ processNext: async () => retry });
		const log = vi.fn();
		const background = startMutationCloudV3Background(
			{ root: "/repo", log, intervalMs: 60_000 },
			deps,
		);

		expect(await background.tick()).toBe("processed");
		expect(log).toHaveBeenCalledWith(
			"Mutation cloud background job job-3 remains durable for retry after poll: remote timeout",
		);
		background.stop();
	});

	it("reports a finding that lost its delivery lease before it could be released", async () => {
		const lostLease: MutationFindingDeliveryOutcome = {
			kind: "lost_lease",
			outboxId: `1:${"c".repeat(64)}`,
			stage: "release",
			message: "[interlinked:mutation] adverse result",
		};
		const deps = dependencies({ deliverOneFinding: async () => lostLease });
		const log = vi.fn();
		const background = startMutationCloudV3Background(
			{ root: "/repo", log, intervalMs: 60_000 },
			deps,
		);

		expect(await background.tick()).toBe("processed");
		expect(log).toHaveBeenCalledWith(
			`Mutation cloud finding 1:${"c".repeat(64)} lost its local delivery lease during release; it remains in the durable feed.`,
		);
		background.stop();
	});

	it("reports a finding scheduled for delivery retry", async () => {
		const retry: MutationFindingDeliveryOutcome = {
			kind: "retry",
			outboxId: `1:${"d".repeat(64)}`,
			stage: "sink",
			message: "[interlinked:mutation] adverse result",
		};
		const deps = dependencies({ deliverOneFinding: async () => retry });
		const log = vi.fn();
		const background = startMutationCloudV3Background(
			{ root: "/repo", log, intervalMs: 60_000 },
			deps,
		);

		expect(await background.tick()).toBe("processed");
		expect(log).toHaveBeenCalledWith(
			`Mutation cloud finding 1:${"d".repeat(64)} remains durable for retry after sink.`,
		);
		background.stop();
	});

	it("logs a distinct diagnostic when closing the runtime after a successful cycle fails", async () => {
		const processNext = vi.fn(async () => IDLE);
		const deliverOneFinding = vi.fn(async () => ({ kind: "idle" as const }));
		const close = vi.fn(() => {
			throw new Error("handle already closed");
		});
		const openRuntime = vi.fn(() => ({ processNext, deliverOneFinding, close }));
		const log = vi.fn();
		const background = startMutationCloudV3Background(
			{ root: "/repo", log, intervalMs: 60_000 },
			{
				configExists: vi.fn(() => true),
				loadConfig: vi.fn(() => ({ ...runtimeConfig(), backgroundEnabled: true })),
				openRuntime,
			},
		);

		expect(await background.tick()).toBe("idle");
		expect(log).toHaveBeenCalledWith("Mutation cloud background runtime close failed: handle already closed");
		background.stop();
	});

	it("fires a real tick from the scheduled interval callback", async () => {
		const deps = dependencies();
		let scheduled: (() => void) | undefined;
		const fakeTimer = setInterval(() => undefined, 60_000);
		clearInterval(fakeTimer);
		const background = startMutationCloudV3Background(
			{ root: "/repo", log: vi.fn(), intervalMs: 60_000 },
			{
				...deps,
				setInterval: vi.fn((callback: () => void) => {
					scheduled = callback;
					return fakeTimer;
				}),
				clearInterval: vi.fn(),
			},
		);

		expect(scheduled).toBeDefined();
		scheduled?.();
		await vi.waitFor(() => expect(deps.processNext).toHaveBeenCalledTimes(1));
		background.stop();
	});

	it("composes the real mutation cloud runtime when no runtime override is supplied", async () => {
		const log = vi.fn();
		const background = startMutationCloudV3Background(
			{ root: "/repo", log, intervalMs: 60_000 },
			{
				configExists: vi.fn(() => true),
				loadConfig: vi.fn(() => ({ ...runtimeConfig(), backgroundEnabled: true, owner: "" })),
			},
		);

		expect(await background.tick()).toBe("failed");
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("mutation cloud runtime owner is required"),
		);
		background.stop();
	});
});
