import { describe, it, expect } from "vitest";
import {
	createCheckHealthAccumulator,
	foldRecurrenceLine,
	foldCheckHealthEvent,
	finalizeCheckHealth,
	classifyCheckHealth,
	LOW_DATA_EVENT_FLOOR,
} from "./check-health.js";

describe("foldRecurrenceLine — line ingestion", () => {
	it.each(["   ", ""])("ignores a blank line %j without recording an event", (line) => {
		const acc = createCheckHealthAccumulator();
		const result = foldRecurrenceLine(acc, line);
		expect(result).toBe(false);
		expect(acc.buckets.size).toBe(0);
	});

	it("records a valid event from a non-blank line", () => {
		const acc = createCheckHealthAccumulator();
		const line = JSON.stringify({
			kind: "harness_caught",
			check_id: "x",
			ts: "2024-01-01T00:00:00Z",
		});
		const result = foldRecurrenceLine(acc, line);
		expect(result).toBe(true);
		expect(acc.buckets.size).toBe(1);
		expect(acc.buckets.has("x")).toBe(true);
	});
});

describe("foldRecurrenceLine / foldCheckHealthEvent — isCaughtRow guard", () => {
	it("N1: a raw JSON null value does not throw and is rejected", () => {
		const acc = createCheckHealthAccumulator();
		expect(() => foldRecurrenceLine(acc, "null")).not.toThrow();
		expect(foldRecurrenceLine(acc, "null")).toBe(false);
		expect(acc.buckets.size).toBe(0);
	});

	it("N2: an array JSON value is rejected", () => {
		const acc = createCheckHealthAccumulator();
		expect(foldRecurrenceLine(acc, '["irrelevant"]')).toBe(false);
		expect(acc.buckets.size).toBe(0);
	});

	it("N3: empty check_id is rejected", () => {
		const acc = createCheckHealthAccumulator();
		foldCheckHealthEvent(acc, {
			kind: "harness_caught",
			check_id: "",
			ts: "2024-01-01T00:00:00Z",
		});
		expect(acc.buckets.size).toBe(0);
	});

	it("N4: non-string ts is rejected", () => {
		const acc = createCheckHealthAccumulator();
		foldRecurrenceLine(acc, JSON.stringify({
			kind: "harness_caught",
			check_id: "chk",
			ts: 12345,
		}));
		expect(acc.buckets.size).toBe(0);
	});

	it("P1: a valid harness_caught row with non-empty check_id and string ts is accepted", () => {
		const acc = createCheckHealthAccumulator();
		foldCheckHealthEvent(acc, {
			kind: "harness_caught",
			check_id: "chk",
			ts: "2024-01-01T00:00:00Z",
		});
		expect(acc.buckets.size).toBe(1);
		expect(acc.buckets.has("chk")).toBe(true);
	});
});

describe("foldCaughtRow — first_seen / last_seen bucket tracking", () => {
	it("P1: last_seen does not regress to an earlier event's timestamp", () => {
		const acc = createCheckHealthAccumulator();
		foldCheckHealthEvent(acc, {
			kind: "harness_caught",
			check_id: "chk",
			ts: "2024-06-01T00:00:00Z",
		});
		foldCheckHealthEvent(acc, {
			kind: "harness_caught",
			check_id: "chk",
			ts: "2024-01-01T00:00:00Z",
		});
		const bucket = acc.buckets.get("chk")!;
		expect(bucket.last_seen).toBe("2024-06-01T00:00:00Z");
		expect(bucket.first_seen).toBe("2024-01-01T00:00:00Z");
	});

	it("P2: equal-millisecond timestamps (different string form) do not overwrite first_seen/last_seen", () => {
		const acc = createCheckHealthAccumulator();
		foldCheckHealthEvent(acc, {
			kind: "harness_caught",
			check_id: "chk",
			ts: "2024-01-01T00:00:00.000Z",
		});
		// Same instant, different string representation.
		foldCheckHealthEvent(acc, {
			kind: "harness_caught",
			check_id: "chk",
			ts: "2024-01-01T00:00:00Z",
		});
		const bucket = acc.buckets.get("chk")!;
		expect(bucket.first_seen).toBe("2024-01-01T00:00:00.000Z");
		expect(bucket.last_seen).toBe("2024-01-01T00:00:00.000Z");
	});
});

describe("finalizeCheckHealth — division guard and sort order", () => {
	it("P1: a bucket with zero unique findings reports repeat_rate 0, never NaN/Infinity", () => {
		const acc = createCheckHealthAccumulator();
		acc.buckets.set("weird", {
			events: 5,
			findings: new Set<string>(),
			sessions: new Set<string>(),
			first_seen: "2024-01-01T00:00:00Z",
			last_seen: "2024-01-01T00:00:00Z",
		});
		const rows = finalizeCheckHealth(acc, () => "heuristic");
		expect(rows).toHaveLength(1);
		const [row] = rows;
		expect(row).toBeDefined();
		expect(row?.repeat_rate).toBe(0);
	});

	it("P2: rows are sorted desc by repeat_rate, then desc by events, then asc by check_id", () => {
		const acc = createCheckHealthAccumulator();
		const mk = (events: number, uniqueCount: number) => ({
			events,
			findings: new Set<string>(Array.from({ length: uniqueCount }, (_, i) => `f${i}`)),
			sessions: new Set<string>(),
			first_seen: "2024-01-01T00:00:00Z",
			last_seen: "2024-01-01T00:00:00Z",
		});
		// Insertion order deliberately does NOT match the expected sorted order.
		acc.buckets.set("checkA", mk(2, 2)); // rate 1
		acc.buckets.set("checkB", mk(10, 2)); // rate 5, events 10
		acc.buckets.set("checkC", mk(6, 2)); // rate 3
		acc.buckets.set("checkD", mk(15, 3)); // rate 5, events 15
		acc.buckets.set("checkE", mk(10, 2)); // rate 5, events 10 (tie w/ B on rate+events)

		const rows = finalizeCheckHealth(acc, () => "heuristic");
		const order = rows.map((r) => r.check_id);
		expect(order).toEqual(["checkD", "checkB", "checkE", "checkC", "checkA"]);
	});
});

describe("classifyCheckHealth — LOW_DATA_EVENT_FLOOR boundary", () => {
	it("P1: events exactly at the floor is NOT low-data (boundary is exclusive)", () => {
		const status = classifyCheckHealth({
			events: LOW_DATA_EVENT_FLOOR,
			unique_findings: 5,
			repeat_rate: 5,
			determinism: "heuristic",
		});
		expect(status).toBe("probation-candidate");
	});

	it("N1: events one below the floor is low-data", () => {
		const status = classifyCheckHealth({
			events: LOW_DATA_EVENT_FLOOR - 1,
			unique_findings: 5,
			repeat_rate: 5,
			determinism: "heuristic",
		});
		expect(status).toBe("low-data");
	});
});
