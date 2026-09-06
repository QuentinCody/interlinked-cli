import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimedOutboxEntry, OutboxLeaseRef } from "./mutation-journal-types.js";
import {
	MUTATION_FINDING_DELIVERY_RELATIVE_PATH,
	deliverOneMutationFinding,
	type MutationFindingDeliveryRecord,
	type MutationFindingDeliveryOutcome,
	type MutationFindingOutbox,
} from "./mutation-cloud-v3-finding-delivery.js";

const FINDING_ID = "a".repeat(64);
const OUTBOX_ID = `7:${FINDING_ID}`;
const LEASE_TOKEN = "123e4567-e89b-42d3-a456-426614174000";

function findingPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		finding_version: "1",
		delivery_finding_id: FINDING_ID,
		semantic_finding_fingerprint: "b".repeat(64),
		category: "adverse",
		severity: "error",
		verdict: "adverse",
		message: "raw evaluator detail is intentionally not delivered",
		target: "src/answer.ts",
		acceptance_receipt_hash: "c".repeat(64),
		result_hash: "d".repeat(64),
		evaluator_policy_version: "policy-v1",
		evidence_completeness: "complete",
		...overrides,
	};
}

function claim(overrides: Partial<ClaimedOutboxEntry> = {}): ClaimedOutboxEntry {
	return {
		outboxId: OUTBOX_ID,
		evaluationId: 7,
		topic: "mutation.finding",
		payload: findingPayload(),
		leaseToken: LEASE_TOKEN,
		leaseExpiresAtMs: 2_000,
		attemptCount: 1,
		...overrides,
	};
}

function outbox(claims: Array<ClaimedOutboxEntry | null>): MutationFindingOutbox & {
	claimOutbox: ReturnType<typeof vi.fn>;
	releaseOutbox: ReturnType<typeof vi.fn>;
	acknowledgeOutbox: ReturnType<typeof vi.fn>;
} {
	return {
		claimOutbox: vi.fn(() => claims.shift() ?? null),
		releaseOutbox: vi.fn((_input: OutboxLeaseRef) => true),
		acknowledgeOutbox: vi.fn((_input: OutboxLeaseRef) => true),
	};
}

const roots: string[] = [];

async function createRoot(): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), "interlinked-finding-delivery-"));
	roots.push(value);
	return value;
}

function surfacedMessage(outcome: MutationFindingDeliveryOutcome): string {
	if (outcome.kind === "idle") throw new Error("expected a claimed finding delivery outcome");
	return outcome.message;
}

afterEach(async () => {
	for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true });
});

describe("deliverOneMutationFinding", () => {
	it("returns idle when the journal has no claimable finding", async () => {
		const journal = outbox([null]);
		const append = vi.fn();

		await expect(deliverOneMutationFinding({
			root: await createRoot(),
			owner: "daemon-a",
			leaseMs: 1_000,
			journal,
			clock: () => 100,
			append,
		})).resolves.toEqual({ kind: "idle" });
		expect(append).not.toHaveBeenCalled();
		expect(journal.acknowledgeOutbox).not.toHaveBeenCalled();
	});

	it("appends the durable record before acknowledging with the exact lease", async () => {
		const events: string[] = [];
		const journal = outbox([claim()]);
		journal.acknowledgeOutbox.mockImplementation((input: OutboxLeaseRef) => {
			events.push(`ack:${input.outboxId}:${input.leaseToken}`);
			return true;
		});
		const append = vi.fn(async (_root: string, record: MutationFindingDeliveryRecord) => {
			events.push(`append:${record.outbox_id}`);
		});

		const outcome = await deliverOneMutationFinding({
			root: await createRoot(),
			owner: "daemon-a",
			leaseMs: 1_000,
			journal,
			clock: () => 100,
			append,
		});

		expect(outcome).toMatchObject({ kind: "delivered", outboxId: OUTBOX_ID });
		expect(events).toEqual([`append:${OUTBOX_ID}`, `ack:${OUTBOX_ID}:${LEASE_TOKEN}`]);
		expect(journal.releaseOutbox).not.toHaveBeenCalled();
	});

	it("releases the exact lease after an append failure and returns retry", async () => {
		const journal = outbox([claim()]);
		const append = vi.fn(async () => {
			throw new Error("disk unavailable");
		});

		await expect(deliverOneMutationFinding({
			root: await createRoot(),
			owner: "daemon-a",
			leaseMs: 1_000,
			journal,
			clock: () => 100,
			append,
		})).resolves.toMatchObject({ kind: "retry", stage: "sink", outboxId: OUTBOX_ID });
		expect(journal.releaseOutbox).toHaveBeenCalledWith({
			outboxId: OUTBOX_ID,
			leaseToken: LEASE_TOKEN,
			nowMs: 100,
		});
		expect(journal.acknowledgeOutbox).not.toHaveBeenCalled();
	});

	it("leaves an appended row leased for expiry when acknowledgement loses the fence", async () => {
		const journal = outbox([claim()]);
		journal.acknowledgeOutbox.mockReturnValue(false);
		const append = vi.fn(async () => undefined);

		await expect(deliverOneMutationFinding({
			root: await createRoot(),
			owner: "daemon-a",
			leaseMs: 1_000,
			journal,
			clock: () => 100,
			append,
		})).resolves.toMatchObject({ kind: "lost_lease", stage: "acknowledge", outboxId: OUTBOX_ID });
		expect(append).toHaveBeenCalledTimes(1);
		expect(journal.releaseOutbox).not.toHaveBeenCalled();
	});

	it("keeps the stable outbox id across at-least-once duplicate appends", async () => {
		const journal = outbox([
			claim({ leaseToken: "123e4567-e89b-42d3-a456-426614174001", attemptCount: 1 }),
			claim({ leaseToken: "123e4567-e89b-42d3-a456-426614174002", attemptCount: 2 }),
		]);
		journal.acknowledgeOutbox.mockReturnValueOnce(false).mockReturnValueOnce(true);
		const records: MutationFindingDeliveryRecord[] = [];
		const append = vi.fn(async (_root: string, record: MutationFindingDeliveryRecord) => {
			records.push(record);
		});

		const options = {
			root: await createRoot(),
			owner: "daemon-a",
			leaseMs: 1_000,
			journal,
			clock: () => 100,
			append,
		};
		await deliverOneMutationFinding(options);
		await deliverOneMutationFinding(options);

		expect(records.map((record) => record.outbox_id)).toEqual([OUTBOX_ID, OUTBOX_ID]);
		expect(records.map((record) => record.delivery_attempt)).toEqual([1, 2]);
	});

	it("renders a bounded generic message without reflecting malformed payload data", async () => {
		const journal = outbox([claim({ payload: { message: "DO-NOT-LEAK", secret: "customer-value" } })]);
		const records: MutationFindingDeliveryRecord[] = [];

		const outcome = await deliverOneMutationFinding({
			root: await createRoot(),
			owner: "daemon-a",
			leaseMs: 1_000,
			journal,
			clock: () => 100,
			append: async (_root, record) => void records.push(record),
		});

		expect(surfacedMessage(outcome)).toContain("authenticated local journal");
		expect(JSON.stringify(records)).not.toContain("DO-NOT-LEAK");
		expect(JSON.stringify(records)).not.toContain("customer-value");
		expect(records[0]?.payload).toMatchObject({ finding_version: "unrecognized", category: "unknown" });
	});

	it("caps a valid structured finding without reflecting the evaluator's raw message", async () => {
		const target = `${"a".repeat(509)}.ts`;
		const journal = outbox([claim({
			payload: findingPayload({ category: "not_measured", severity: "warning", verdict: "not_measured", target }),
		})]);
		const records: MutationFindingDeliveryRecord[] = [];

		const outcome = await deliverOneMutationFinding({
			root: await createRoot(),
			owner: "daemon-a",
			leaseMs: 1_000,
			journal,
			clock: () => 100,
			append: async (_root, record) => void records.push(record),
		});

		expect(surfacedMessage(outcome).length).toBeLessThanOrEqual(640);
		expect(JSON.stringify(records)).not.toContain("raw evaluator detail");
		expect(records[0]?.payload.category).toBe("not_measured");
	});

	it.each([
		["relative root", { root: "relative" }],
		["unsafe owner", { owner: "daemon owner" }],
		["zero lease", { leaseMs: 0 }],
		["invalid clock", { clock: () => Number.NaN }],
	])("rejects %s before claiming the journal", async (_name, override) => {
		const journal = outbox([null]);
		const base = {
			root: await createRoot(),
			owner: "daemon-a",
			leaseMs: 1_000,
			journal,
			clock: () => 100,
		};

		await expect(deliverOneMutationFinding({ ...base, ...override })).rejects.toThrow();
		expect(journal.claimOutbox).not.toHaveBeenCalled();
	});

	it("creates the real local sink and appends one parseable versioned JSONL record", async () => {
		const repoRoot = await createRoot();
		const journal = outbox([claim()]);

		await expect(deliverOneMutationFinding({
			root: repoRoot,
			owner: "daemon-a",
			leaseMs: 1_000,
			journal,
			clock: () => 100,
		})).resolves.toMatchObject({ kind: "delivered", outboxId: OUTBOX_ID });
		const text = await readFile(join(repoRoot, MUTATION_FINDING_DELIVERY_RELATIVE_PATH), "utf8");
		expect(text).not.toContain("raw evaluator detail");
		const lines = text.trimEnd().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
			delivery_version: "1",
			outbox_id: OUTBOX_ID,
			topic: "mutation.finding",
			delivery_attempt: 1,
			delivered_at: "1970-01-01T00:00:00.100Z",
			payload: {
				finding_version: "1",
				category: "adverse",
				target: "src/answer.ts",
			},
		});
	});

	it("rejects a root that resolves to a filesystem root before claiming the journal", async () => {
		const journal = outbox([null]);

		await expect(deliverOneMutationFinding({
			root: "/",
			owner: "daemon-a",
			leaseMs: 1_000,
			journal,
			clock: () => 100,
		})).rejects.toThrow("mutation finding delivery root must not be a filesystem root");
		expect(journal.claimOutbox).not.toHaveBeenCalled();
	});

	it("falls back to the generic message when the finding category is not recognized", async () => {
		const journal = outbox([claim({ payload: findingPayload({ category: "bogus-category" }) })]);
		const records: MutationFindingDeliveryRecord[] = [];

		const outcome = await deliverOneMutationFinding({
			root: await createRoot(),
			owner: "daemon-a",
			leaseMs: 1_000,
			journal,
			clock: () => 100,
			append: async (_root, record) => void records.push(record),
		});

		expect(surfacedMessage(outcome)).toContain("authenticated local journal");
		expect(records[0]?.payload).toMatchObject({ finding_version: "unrecognized", category: "unknown" });
	});

	it("falls back to the generic message when the finding verdict is not recognized", async () => {
		const journal = outbox([claim({ payload: findingPayload({ verdict: "bogus-verdict" }) })]);
		const records: MutationFindingDeliveryRecord[] = [];

		const outcome = await deliverOneMutationFinding({
			root: await createRoot(),
			owner: "daemon-a",
			leaseMs: 1_000,
			journal,
			clock: () => 100,
			append: async (_root, record) => void records.push(record),
		});

		expect(surfacedMessage(outcome)).toContain("authenticated local journal");
		expect(records[0]?.payload).toMatchObject({ finding_version: "unrecognized", category: "unknown" });
	});

	it("falls back to the generic message when the finding target escapes the repo root", async () => {
		const journal = outbox([claim({ payload: findingPayload({ target: "/etc/passwd" }) })]);
		const records: MutationFindingDeliveryRecord[] = [];

		const outcome = await deliverOneMutationFinding({
			root: await createRoot(),
			owner: "daemon-a",
			leaseMs: 1_000,
			journal,
			clock: () => 100,
			append: async (_root, record) => void records.push(record),
		});

		expect(surfacedMessage(outcome)).toContain("authenticated local journal");
		expect(records[0]?.payload).toMatchObject({ finding_version: "unrecognized", category: "unknown" });
	});

	it("falls back to the generic message when the semantic finding fingerprint is not a sha256 hex digest", async () => {
		const journal = outbox([claim({ payload: findingPayload({ semantic_finding_fingerprint: "not-a-hash" }) })]);
		const records: MutationFindingDeliveryRecord[] = [];

		const outcome = await deliverOneMutationFinding({
			root: await createRoot(),
			owner: "daemon-a",
			leaseMs: 1_000,
			journal,
			clock: () => 100,
			append: async (_root, record) => void records.push(record),
		});

		expect(surfacedMessage(outcome)).toContain("authenticated local journal");
		expect(records[0]?.payload).toMatchObject({ finding_version: "unrecognized", category: "unknown" });
	});

	it("falls back to the generic message when the acceptance receipt hash is not a sha256 hex digest", async () => {
		const journal = outbox([claim({ payload: findingPayload({ acceptance_receipt_hash: "not-a-hash" }) })]);
		const records: MutationFindingDeliveryRecord[] = [];

		const outcome = await deliverOneMutationFinding({
			root: await createRoot(),
			owner: "daemon-a",
			leaseMs: 1_000,
			journal,
			clock: () => 100,
			append: async (_root, record) => void records.push(record),
		});

		expect(surfacedMessage(outcome)).toContain("authenticated local journal");
		expect(records[0]?.payload).toMatchObject({ finding_version: "unrecognized", category: "unknown" });
	});

	it("retries at the sink stage when the real append target is a symlink instead of a real directory", async () => {
		const repoRoot = await createRoot();
		const realDir = join(repoRoot, "actual-dir");
		await mkdir(realDir, { recursive: true });
		await symlink(realDir, join(repoRoot, ".interlinked"));
		const journal = outbox([claim()]);

		const outcome = await deliverOneMutationFinding({
			root: repoRoot,
			owner: "daemon-a",
			leaseMs: 1_000,
			journal,
			clock: () => 100,
		});

		expect(outcome).toMatchObject({ kind: "retry", stage: "sink", outboxId: OUTBOX_ID });
		expect(journal.releaseOutbox).toHaveBeenCalledWith({
			outboxId: OUTBOX_ID,
			leaseToken: LEASE_TOKEN,
			nowMs: 100,
		});
	});

	it("reports lost_lease at the release stage when releasing after a sink failure itself throws", async () => {
		const journal = outbox([claim()]);
		journal.releaseOutbox.mockImplementation(() => {
			throw new Error("journal store unavailable");
		});
		const append = vi.fn(async () => {
			throw new Error("disk unavailable");
		});

		const outcome = await deliverOneMutationFinding({
			root: await createRoot(),
			owner: "daemon-a",
			leaseMs: 1_000,
			journal,
			clock: () => 100,
			append,
		});

		expect(outcome).toMatchObject({ kind: "lost_lease", stage: "release", outboxId: OUTBOX_ID });
		expect(journal.acknowledgeOutbox).not.toHaveBeenCalled();
	});

	it("retries at the acknowledge stage when acknowledging after a successful append throws", async () => {
		const journal = outbox([claim()]);
		journal.acknowledgeOutbox.mockImplementation(() => {
			throw new Error("journal store unavailable");
		});
		const append = vi.fn(async () => undefined);

		const outcome = await deliverOneMutationFinding({
			root: await createRoot(),
			owner: "daemon-a",
			leaseMs: 1_000,
			journal,
			clock: () => 100,
			append,
		});

		expect(outcome).toMatchObject({ kind: "retry", stage: "acknowledge", outboxId: OUTBOX_ID });
		expect(surfacedMessage(outcome)).toContain("authenticated local journal");
	});
});
