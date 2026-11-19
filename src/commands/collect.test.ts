import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCollectCommand } from "./collect.js";

/** Run `collect` with args; capture stdout/stderr and process.exitCode. */
function run(args: string[]): { out: string[]; err: string[]; code: number | undefined } {
	const out: string[] = [];
	const err: string[] = [];
	const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
	const error = vi.spyOn(console, "error").mockImplementation((m) => void err.push(String(m)));
	const prev = process.exitCode;
	process.exitCode = undefined;
	try {
		const program = new Command();
		program.exitOverride();
		registerCollectCommand(program);
		program.parse(["node", "interlinked", "collect", ...args]);
	} finally {
		log.mockRestore();
		error.mockRestore();
	}
	const code = process.exitCode;
	process.exitCode = prev;
	return { out, err, code: typeof code === "number" ? code : undefined };
}

function fixture(): { dir: string; cwd: string } {
	const dir = mkdtempSync(join(tmpdir(), "collect-src-"));
	const cwd = mkdtempSync(join(tmpdir(), "collect-cwd-"));
	mkdirSync(join(cwd, ".interlinked"), { recursive: true });
	const day = join(dir, "2026", "07", "18");
	mkdirSync(day, { recursive: true });
	const rollout = [
		{ timestamp: "2026-07-18T18:40:04Z", type: "session_meta", payload: { session_id: "s1", cwd: "/r" } },
		{ timestamp: "2026-07-18T18:40:05Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "Go." }] } },
		{ timestamp: "2026-07-18T18:40:06Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Ok." }] } },
	]
		.map((e) => JSON.stringify(e))
		.join("\n");
	writeFileSync(join(day, "rollout-a.jsonl"), rollout);
	return { dir, cwd };
}

describe("interlinked collect", () => {
	afterEach(() => vi.restoreAllMocks());

	it("collects codex sessions into the target timeline (json)", () => {
		const { dir, cwd } = fixture();
		const { out, code } = run(["--dir", dir, "--cwd", cwd, "--json"]);
		expect(code).toBeUndefined();
		const parsed = JSON.parse(out[0] ?? "{}");
		expect(parsed.ok).toBe(true);
		expect(parsed.provider).toBe("codex");
		expect(parsed.added).toBeGreaterThan(0);
		const recs = readFileSync(join(cwd, ".interlinked", "timeline.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(recs.some((r) => r.provider === "codex" && r.text === "Go.")).toBe(true);
	});

	it("is idempotent across runs", () => {
		const { dir, cwd } = fixture();
		run(["--dir", dir, "--cwd", cwd]);
		const { out } = run(["--dir", dir, "--cwd", cwd, "--json"]);
		expect(JSON.parse(out[0] ?? "{}").added).toBe(0);
	});

	it("dry-run writes nothing", () => {
		const { dir, cwd } = fixture();
		const { out } = run(["--dir", dir, "--cwd", cwd, "--dry-run", "--json"]);
		expect(JSON.parse(out[0] ?? "{}").added).toBeGreaterThan(0);
		let wrote = true;
		try {
			readFileSync(join(cwd, ".interlinked", "timeline.jsonl"), "utf8");
		} catch {
			wrote = false;
		}
		expect(wrote).toBe(false);
	});

	it("rejects a non-codex provider with exit 2 and a helpful message", () => {
		const { code, out } = run(["--provider", "claude", "--json"]);
		expect(code).toBe(2);
		expect(JSON.parse(out[0] ?? "{}").error).toContain("already captured live");
	});

	it("rejects a non-codex provider with exit 2 and a stderr message (non-json)", () => {
		const { code, err, out } = run(["--provider", "claude"]);
		expect(code).toBe(2);
		expect(err[0]).toContain("already captured live");
		expect(out).toHaveLength(0);
	});

	it("rejects a malformed --since", () => {
		const { dir, cwd } = fixture();
		const { code, out } = run(["--dir", dir, "--cwd", cwd, "--since", "banana", "--json"]);
		expect(code).toBe(2);
		expect(JSON.parse(out[0] ?? "{}").error).toContain("Invalid duration");
	});

	it.each(["", "   "])("rejects explicit blank --since %j before collecting", (since) => {
		const { dir, cwd } = fixture();
		const { code, out } = run(["--dir", dir, "--cwd", cwd, "--since", since, "--json"]);
		expect(code).toBe(2);
		expect(JSON.parse(out[0] ?? "{}").ok).toBe(false);
		expect(() => readFileSync(join(cwd, ".interlinked", "timeline.jsonl"))).toThrow();
	});

	it("rejects a malformed --since with exit 2 and a stderr message (non-json)", () => {
		const { dir, cwd } = fixture();
		const { code, err, out } = run(["--dir", dir, "--cwd", cwd, "--since", "banana"]);
		expect(code).toBe(2);
		expect(err[0]).toContain("Invalid duration");
		expect(out).toHaveLength(0);
	});
});
