import { describe, expect, it, vi } from "vitest";
import {
	type GitContextResult,
	type LinkCheckpointResult,
	formatGitContextOutput,
	formatLinkCheckpointOutput,
	resolveCheckpointId,
	resolveServerContext,
	serverPushResultPatch,
} from "./git-support.js";

function baseContext(): GitContextResult {
	return { branch: "main", head: "abc1234", attribution: null, trailers: {} };
}

describe("formatGitContextOutput", () => {
	it("renders branch and head", () => {
		const out = formatGitContextOutput(baseContext());
		expect(out).toContain("Branch");
		expect(out).toContain("main");
		expect(out).toContain("abc1234");
	});

	it("falls back to placeholders when branch and head are null", () => {
		const out = formatGitContextOutput({ ...baseContext(), branch: null, head: null });
		expect(out).toContain("detached HEAD");
		expect(out).toContain("unknown");
	});

	it("renders the attribution line when present", () => {
		const out = formatGitContextOutput({
			...baseContext(),
			attribution: { agent_percentage: 80, agent_lines: 8, total_lines: 10 },
		});
		expect(out).toContain("80% agent (8/10 lines)");
	});

	it("omits the attribution line when absent", () => {
		expect(formatGitContextOutput(baseContext())).not.toContain("Attribution");
	});

	it("renders local trailers", () => {
		const out = formatGitContextOutput({
			...baseContext(),
			trailers: { "Interlinked-Checkpoint": "42" },
		});
		expect(out).toContain("Local Trailers");
		expect(out).toContain("Interlinked-Checkpoint");
		expect(out).toContain("42");
	});

	it("renders the server error instead of a server block", () => {
		const out = formatGitContextOutput({
			...baseContext(),
			server: { error: "not authenticated" },
		});
		expect(out).toContain("not authenticated");
		expect(out).not.toContain("Server Context");
	});

	it("renders checkpoint, agent, and split server trailers", () => {
		const out = formatGitContextOutput({
			...baseContext(),
			server: {
				checkpoint: "#7",
				agent: "Worker",
				trailers: ["Interlinked-Agent: Worker", "no-colon-line"],
			},
		});
		expect(out).toContain("Server Context");
		expect(out).toContain("#7");
		expect(out).toContain("Worker");
		expect(out).toContain("Interlinked-Agent");
		expect(out).toContain("no-colon-line");
	});
});

describe("serverPushResultPatch", () => {
	it("returns an empty patch for a null server result", () => {
		expect(serverPushResultPatch(null)).toEqual({});
	});

	it("copies trailers, notes, and notes_json", () => {
		expect(
			serverPushResultPatch({
				checkpoint_id: 1,
				trailers: ["A: b"],
				trailers_text: "A: b",
				notes: { a: "b" },
				notes_json: '{"a":"b"}',
				instructions: "",
			}),
		).toEqual({ trailers: ["A: b"], notes: { a: "b" }, notes_json: '{"a":"b"}' });
	});
});

describe("formatLinkCheckpointOutput", () => {
	const base: LinkCheckpointResult = { checkpoint_id: 5, commit_sha: "deadbee" };

	it("renders checkpoint and commit", () => {
		const out = formatLinkCheckpointOutput(base, false);
		expect(out).toContain("#5");
		expect(out).toContain("deadbee");
	});

	it("shows unknown when the commit sha is missing", () => {
		expect(formatLinkCheckpointOutput({ checkpoint_id: 5 }, false)).toContain("unknown");
	});

	it("renders a trailers section only when trailers exist", () => {
		expect(formatLinkCheckpointOutput({ ...base, trailers: [] }, false)).not.toContain("Trailers");
		expect(formatLinkCheckpointOutput({ ...base, trailers: ["A: b"] }, false)).toContain(
			"Trailers",
		);
	});

	it("notes the attached JSON when notes_json is set", () => {
		expect(formatLinkCheckpointOutput({ ...base, notes_json: "{}" }, false)).toContain(
			"(JSON attached)",
		);
	});

	it("reports success when applied", () => {
		const out = formatLinkCheckpointOutput({ ...base, applied: true }, true);
		expect(out).toContain("Trailers and notes applied to HEAD.");
		expect(out).toContain("HEAD was amended");
	});

	it("reports failure when apply was requested but did not happen", () => {
		expect(formatLinkCheckpointOutput({ ...base, applied: false }, true)).toContain(
			"Failed to apply trailers.",
		);
	});

	it("hints at --apply when apply was not requested", () => {
		expect(formatLinkCheckpointOutput(base, false)).toContain("Use --apply");
	});
});

describe("resolveServerContext", () => {
	it("maps latest_checkpoint onto the server block", async () => {
		vi.doMock("../lib/api-client.js", () => ({
			getClient: () => ({
				callTool: async () => ({
					latest_checkpoint: { id: 9, agent: "Worker", summary: "did a thing" },
					trailers: ["A: b"],
				}),
			}),
		}));
		vi.resetModules();
		const mod = await import("./git-support.js");
		expect(await mod.resolveServerContext(undefined)).toEqual({
			checkpoint: '#9 — "did a thing"',
			agent: "Worker",
			trailers: ["A: b"],
		});
		vi.doUnmock("../lib/api-client.js");
		vi.resetModules();
	});

	it("maps the first bridge event when there is no latest_checkpoint", async () => {
		vi.doMock("../lib/api-client.js", () => ({
			getClient: () => ({
				callTool: async () => ({
					bridge_events: [
						{ id: 1, event_type: "push", checkpoint_id: 3, checkpoint_summary: "s", agent_name: "A" },
					],
					trailers: [],
				}),
			}),
		}));
		vi.resetModules();
		const mod = await import("./git-support.js");
		expect(await mod.resolveServerContext("abc")).toEqual({
			checkpoint: '#3 — "s"',
			agent: "A",
			trailers: [],
		});
		vi.doUnmock("../lib/api-client.js");
		vi.resetModules();
	});

	it("returns only trailers when neither checkpoint nor bridge events are present", async () => {
		vi.doMock("../lib/api-client.js", () => ({
			getClient: () => ({ callTool: async () => ({ trailers: ["X: y"] }) }),
		}));
		vi.resetModules();
		const mod = await import("./git-support.js");
		expect(await mod.resolveServerContext(undefined)).toEqual({ trailers: ["X: y"] });
		vi.doUnmock("../lib/api-client.js");
		vi.resetModules();
	});

	it("returns undefined when the server returns nothing", async () => {
		vi.doMock("../lib/api-client.js", () => ({
			getClient: () => ({ callTool: async () => null }),
		}));
		vi.resetModules();
		const mod = await import("./git-support.js");
		expect(await mod.resolveServerContext(undefined)).toBeUndefined();
		vi.doUnmock("../lib/api-client.js");
		vi.resetModules();
	});

	it("labels an auth failure as not authenticated", async () => {
		vi.doMock("../lib/api-client.js", () => ({
			getClient: () => ({
				callTool: async () => {
					throw new Error("Not authenticated with server");
				},
			}),
		}));
		vi.resetModules();
		const mod = await import("./git-support.js");
		expect(await mod.resolveServerContext(undefined)).toEqual({ error: "not authenticated" });
		vi.doUnmock("../lib/api-client.js");
		vi.resetModules();
	});

	it("labels any other failure as unreachable", async () => {
		vi.doMock("../lib/api-client.js", () => ({
			getClient: () => ({
				callTool: async () => {
					throw "boom";
				},
			}),
		}));
		vi.resetModules();
		const mod = await import("./git-support.js");
		expect(await mod.resolveServerContext(undefined)).toEqual({ error: "unreachable" });
		vi.doUnmock("../lib/api-client.js");
		vi.resetModules();
	});
});

describe("resolveServerContext export identity", () => {
	it("is a function", () => {
		expect(typeof resolveServerContext).toBe("function");
	});
});

describe("resolveCheckpointId", () => {
	const never = async () => {
		throw new Error("must not be called");
	};

	it("parses an explicit checkpoint option without asking the server", async () => {
		expect(await resolveCheckpointId("42", never)).toBe(42);
	});

	it("throws on a non-numeric checkpoint option", async () => {
		await expect(resolveCheckpointId("abc", never)).rejects.toThrow(
			"Invalid checkpoint ID: abc. Must be a number.",
		);
	});

	it("throws when the explicit checkpoint parses to zero", async () => {
		await expect(resolveCheckpointId("0", never)).rejects.toThrow("No checkpoint ID specified");
	});

	it("falls back to the server's latest checkpoint", async () => {
		expect(await resolveCheckpointId(undefined, async () => ({ latest_checkpoint: { id: 7, agent: "A" } }))).toBe(7);
	});

	it("throws when the server has no latest checkpoint", async () => {
		await expect(resolveCheckpointId(undefined, async () => null)).rejects.toThrow(
			"No checkpoint ID specified and could not fetch latest from server. Use --checkpoint <id>.",
		);
	});

	it("throws when the server fetch itself fails", async () => {
		await expect(
			resolveCheckpointId(undefined, async () => {
				throw new Error("offline");
			}),
		).rejects.toThrow("No checkpoint ID specified");
	});
});
