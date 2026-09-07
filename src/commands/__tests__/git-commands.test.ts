import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================
// Response shape interfaces
// ===========================================

interface GitContextOutput {
	branch: string;
	head: string;
	attribution: {
		agent_percentage: number;
		agent_lines: number;
		total_lines: number;
		human_lines: number;
	};
	trailers: { [key: string]: string };
	server: {
		agent?: string;
		checkpoint?: string;
		error?: string;
	};
}

interface LinkCheckpointOutput {
	checkpoint_id: number;
	trailers: string[];
	notes_json?: string;
	applied: boolean;
}

// ===========================================
// Mocks
// ===========================================

const mockCallTool = vi.fn();
const mockGetConfig = vi.fn(() => ({
	server_url: "https://test.example.com",
	default_workspace_key: "main",
	default_project: "main",
}));
const mockIsAuthenticated = vi.fn(() => true);

vi.mock("../../lib/api-client.js", () => ({
	getClient: vi.fn(() => ({
		callTool: mockCallTool,
		getConfig: mockGetConfig,
		isAuthenticated: mockIsAuthenticated,
	})),
}));

vi.mock("../../lib/git-utils.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../lib/git-utils.js")>();
	return {
		...actual,
		isGitRepo: vi.fn(() => true),
		getCurrentBranch: vi.fn(() => "main"),
		getHeadSha: vi.fn((_cwd: string, short?: boolean) =>
			short === false ? "abc123f456789abcdef012345678901234567890" : "abc123f",
		),
		getCommitMessage: vi.fn(
			() => "Fix auth flow\n\nInterlinked-Checkpoint: 42\nInterlinked-Agent: Worker-Alpha",
		),
		git: vi.fn(() => ""),
	};
});

vi.mock("../../lib/attribution.js", () => ({
	readAttributionTrailer: vi.fn(() => ({
		agent_percentage: 72,
		agent_lines: 145,
		total_lines: 201,
		human_lines: 56,
		per_file: {},
	})),
}));

/** Parse the last console.log call as JSON, throwing a descriptive Error on failure. */
function lastLogAsJson<T>(validate: (v: unknown) => v is T): T {
	const raw = vi.mocked(console.log).mock.calls.at(-1)?.[0];
	if (typeof raw !== "string") {
		throw new Error(`Expected last console.log arg to be a string, got ${typeof raw}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (_e) {
		throw new Error(`Failed to parse console.log output as JSON: ${raw}`);
	}
	if (!validate(parsed)) {
		throw new Error(`Parsed JSON did not match expected shape: ${raw}`);
	}
	return parsed;
}

function isGitContextOutput(v: unknown): v is GitContextOutput {
	return v !== null && typeof v === "object" && "branch" in v && "server" in v;
}

function isLinkCheckpointOutput(v: unknown): v is LinkCheckpointOutput {
	return v !== null && typeof v === "object" && "checkpoint_id" in v;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("git context command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.exitCode = 0;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("outputs JSON with local and server context", async () => {
		// Server returns latest_checkpoint shape (not checkpoint_id at top level)
		mockCallTool.mockResolvedValue({
			latest_checkpoint: {
				id: 42,
				agent: "Worker-Alpha",
				trigger: "manual",
				summary: "Auth refactor complete",
				created_at: "2025-01-01T00:00:00Z",
			},
			trailers: ["Interlinked-Checkpoint: 42", "Interlinked-Agent: Worker-Alpha"],
			commit_sha: null,
		});

		const { gitContextCommand } = await import("../git.js");
		await gitContextCommand({ json: true });

		const output = lastLogAsJson(isGitContextOutput);
		expect(output.branch).toBe("main");
		expect(output.head).toBe("abc123f");
		expect(output.attribution.agent_percentage).toBe(72);
		expect(output.trailers["Interlinked-Checkpoint"]).toBe("42");
		expect(output.server.agent).toBe("Worker-Alpha");
		expect(output.server.checkpoint).toContain("#42");
	});

	it("shows local-only context when server is unreachable", async () => {
		mockCallTool.mockRejectedValue(new Error("unreachable"));

		const { gitContextCommand } = await import("../git.js");
		await gitContextCommand({ json: true });

		const output = lastLogAsJson(isGitContextOutput);
		expect(output.branch).toBe("main");
		expect(output.head).toBe("abc123f");
		expect(output.server.error).toBe("unreachable");
	});

	it("passes commit SHA to server when specified", async () => {
		mockCallTool.mockResolvedValue({});

		const { gitContextCommand } = await import("../git.js");
		await gitContextCommand({ commit: "def456", json: true });

		expect(mockCallTool).toHaveBeenCalledWith(
			"get_git_context",
			expect.objectContaining({ commit_sha: "def456" }),
		);
	});

	it("shows 'not authenticated' for auth errors", async () => {
		mockCallTool.mockRejectedValue(new Error("Not authenticated. Run 'interlinked login'"));

		const { gitContextCommand } = await import("../git.js");
		await gitContextCommand({ json: true });

		const output = lastLogAsJson(isGitContextOutput);
		expect(output.server.error).toBe("not authenticated");
	});

	it("handles bridge_events response (commit SHA match)", async () => {
		mockCallTool.mockResolvedValue({
			commit_sha: "def456",
			bridge_events: [
				{
					id: 1,
					event_type: "checkpoint_push",
					checkpoint_id: 42,
					checkpoint_summary: "Auth refactor",
					agent_name: "Worker-Alpha",
					branch_name: "main",
					pushed_at: "2025-01-01T00:00:00Z",
				},
			],
		});

		const { gitContextCommand } = await import("../git.js");
		await gitContextCommand({ commit: "def456", json: true });

		const output = lastLogAsJson(isGitContextOutput);
		expect(output.server.checkpoint).toContain("#42");
		expect(output.server.agent).toBe("Worker-Alpha");
	});
});

describe("git link-checkpoint command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.exitCode = 0;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("calls push_checkpoint_to_git with correct args (number checkpoint_id)", async () => {
		// Server returns trailers as string[] and notes as object
		mockCallTool.mockResolvedValue({
			checkpoint_id: 42,
			trailers: ["Interlinked-Checkpoint: 42", "Interlinked-Agent: Worker-Alpha"],
			trailers_text: "Interlinked-Checkpoint: 42\nInterlinked-Agent: Worker-Alpha",
			notes: { checkpoint_id: 42, agent: "Worker-Alpha" },
			notes_json: '{"checkpoint_id":42,"agent":"Worker-Alpha"}',
			instructions: "Add trailers to your commit message.",
		});

		const { gitLinkCheckpointCommand } = await import("../git.js");
		await gitLinkCheckpointCommand({ checkpoint: "42", json: true });

		expect(mockCallTool).toHaveBeenCalledWith(
			"push_checkpoint_to_git",
			expect.objectContaining({
				checkpoint_id: 42, // Must be number, not string
				commit_sha: "abc123f456789abcdef012345678901234567890",
				branch_name: "main",
			}),
		);

		const output = lastLogAsJson(isLinkCheckpointOutput);
		expect(output.checkpoint_id).toBe(42);
		expect(output.trailers).toEqual([
			"Interlinked-Checkpoint: 42",
			"Interlinked-Agent: Worker-Alpha",
		]);
		expect(output.notes_json).toBeTruthy();
		expect(output.applied).toBe(false);
	});

	it("fetches latest checkpoint when none specified", async () => {
		// First call: get_git_context returns latest_checkpoint
		mockCallTool.mockResolvedValueOnce({
			latest_checkpoint: { id: 99, agent: "Lead", summary: "Latest" },
			trailers: ["Interlinked-Checkpoint: 99"],
		});
		// Second call: push_checkpoint_to_git
		mockCallTool.mockResolvedValueOnce({
			checkpoint_id: 99,
			trailers: ["Interlinked-Checkpoint: 99"],
			notes: {},
			notes_json: "{}",
		});

		const { gitLinkCheckpointCommand } = await import("../git.js");
		await gitLinkCheckpointCommand({ json: true });

		expect(mockCallTool).toHaveBeenCalledWith("get_git_context", {});
		expect(mockCallTool).toHaveBeenCalledWith(
			"push_checkpoint_to_git",
			expect.objectContaining({ checkpoint_id: 99 }),
		);
	});

	it("errors when no checkpoint available", async () => {
		mockCallTool.mockResolvedValue({ message: "No checkpoints found" });

		const { gitLinkCheckpointCommand } = await import("../git.js");
		await gitLinkCheckpointCommand({ json: true });

		expect(process.exitCode).toBe(1);
		const errorOutput = vi.mocked(console.error).mock.calls.at(-1)?.[0];
		expect(errorOutput).toContain("No checkpoint ID");
	});

	it("rejects non-numeric checkpoint IDs", async () => {
		const { gitLinkCheckpointCommand } = await import("../git.js");
		await gitLinkCheckpointCommand({ checkpoint: "abc", json: true });

		expect(process.exitCode).toBe(1);
		const errorOutput = vi.mocked(console.error).mock.calls.at(-1)?.[0];
		expect(errorOutput).toContain("Invalid checkpoint ID");
	});
});
