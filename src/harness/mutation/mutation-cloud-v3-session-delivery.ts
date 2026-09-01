import type { AsyncFindingQueue, DeferredFinding } from "../async-finding-queue.js";
import type { MutationFindingDeliveryOutcome } from "./mutation-cloud-v3-finding-delivery.js";

type DeliveredMutationFinding = Extract<MutationFindingDeliveryOutcome, { kind: "delivered" }>;

interface ActiveMutationSessionSource {
	getAll(): readonly { session_id: string }[];
}

interface MutationFindingSessionDeliveryOptions {
	sessions: ActiveMutationSessionSource;
	queue: Pick<AsyncFindingQueue, "enqueue">;
	clock?: () => number;
}

type MutationFindingSessionDelivery = (finding: DeliveredMutationFinding) => number;

function deferredFinding(finding: DeliveredMutationFinding, computedAt: string): DeferredFinding {
	return {
		id: `mutation.finding:${finding.outboxId}`,
		check: "mutation_cloud_v3",
		message: finding.message,
		computedAt,
	};
}

/** Build the daemon callback that fans one durable outbox delivery out to
 * every session currently tracked by this repo. The in-memory queues are only
 * notification channels: the fsynced JSONL delivery remains authoritative. */
export function createMutationFindingSessionDelivery(
	options: MutationFindingSessionDeliveryOptions,
): MutationFindingSessionDelivery {
	const clock = options.clock ?? Date.now;
	return (finding) => {
		const computedAt = new Date(clock()).toISOString();
		const deferred = deferredFinding(finding, computedAt);
		const sessionIds = new Set(options.sessions.getAll().map((session) => session.session_id));
		let delivered = 0;
		for (const sessionId of sessionIds) {
			if (sessionId.length === 0) continue;
			options.queue.enqueue(sessionId, deferred);
			delivered += 1;
		}
		return delivered;
	};
}
