import { describe, expect, it } from "vitest";
import { parseActivityFeed } from "./activity-response.js";

describe("activity feed response boundary", () => {
	it.each(["events", "activity", "activities"])("preserves the %s alias and optional evidence", (key) => {
		const response = { [key]: [{ agent: "agent", tool: null, files_modified: ["a.ts"], tokens: { input: 12 }, attribution: { agent_lines: 4 }, extension: { source: "remote" } }] };
		expect(parseActivityFeed(response)).toBe(response);
	});

	it.each([null, undefined])("keeps an absent response absent (%s)", (value) => {
		expect(parseActivityFeed(value)).toBeUndefined();
	});

	it.each([
		{ events: "bad" },
		{ events: [null] },
		{ events: [{ agent: 4 }] },
		{ events: [{ tool: false }] },
		{ events: [{ files_modified: [4] }] },
		{ events: [{ tokens: { input: "12" } }] },
		{ events: [{ attribution: { agent_lines: "4" } }] },
		{ events: [{ schema_version: 99 }] },
		{ activity: [{ duration_ms: Number.NaN }] },
		{ activities: [{ scrubbed: "true" }] },
	])("rejects malformed fields before activity formatting (%j)", (value) => {
		expect(() => parseActivityFeed(value)).toThrow("Invalid activity feed response");
	});
});
