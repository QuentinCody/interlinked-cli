import { parseWire, wireRecord, wireUnknown } from "../lib/value-validation.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------
// Partial node:fs mock: only `existsSync` is intercepted, and only for
// paths explicitly added to `denyState.deny`. Every other fs export
// (readFileSync, writeFileSync, mkdtempSync, rmSync, appendFileSync,
// mkdirSync, statSync, ...) delegates to the real implementation. This
// lets one test simulate "the path is readable but existsSync reports
// it missing" — the only way to observe the transcript-existence guard
// (line 54) independently of the redundant `allPredictions.length===0`
// guard two lines later.
// ---------------------------------------------------------------------
const denyState = vi.hoisted(() => ({ deny: new Set<string>() }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: (p: Parameters<typeof actual.existsSync>[0]) => {
			if (denyState.deny.has(String(p))) return false;
			return actual.existsSync(p);
		},
	};
});

const { harvestPredictionsFromTranscript, readRecentAssistantTexts } = await import(
	"./graph-prediction-stop-hook.js"
);

function assistantLine(text: string): string {
	return `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`;
}

function predictionFence(body: string): string {
	return ["```yaml", "graph_prediction:", body, "```"].join("\n");
}

const tmpDirs: string[] = [];
function makeTmpDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	denyState.deny.clear();
	for (const dir of tmpDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("harvestPredictionsFromTranscript — transcript-path existence guard", () => {
	it("returns an empty result when existsSync reports the transcript missing, even though it is readable", () => {
		const dir = makeTmpDir("gpsh-guard-");
		const transcriptPath = join(dir, "transcript.jsonl");
		writeFileSync(transcriptPath, assistantLine(predictionFence("  file: src/whatever.ts")));
		denyState.deny.add(transcriptPath);

		const result = harvestPredictionsFromTranscript({ cwd: dir, sessionId: "s1", transcriptPath });

		expect(result).toEqual({ persisted: [], skipped: [] });
	});

	it("does not early-return when the transcript path is present and readable (control)", () => {
		const dir = makeTmpDir("gpsh-guard-ctrl-");
		const transcriptPath = join(dir, "transcript.jsonl");
		writeFileSync(transcriptPath, assistantLine(predictionFence("  file: src/whatever.ts")));

		const result = harvestPredictionsFromTranscript({ cwd: dir, sessionId: "s1", transcriptPath });

		// Reaches classification (case A, since no shard pair exists in dir).
		expect(result.skipped).toHaveLength(1);
	});

	it("returns empty persisted/skipped arrays (not a sentinel-populated array) when the transcript is absent", () => {
		const dir = makeTmpDir("gpsh-absent-");
		const result = harvestPredictionsFromTranscript({
			cwd: dir,
			sessionId: "s1",
			transcriptPath: undefined,
		});
		expect(result).toEqual({ persisted: [], skipped: [] });
		expect(result.persisted).toHaveLength(0);
		expect(result.skipped).toHaveLength(0);
	});
});

describe("harvestPredictionsFromTranscript — parse_failed short-circuit", () => {
	it("silently drops a parse_failed prediction (even one with a recovered file) and reports only the valid sibling as non_authoritative_case", () => {
		const dir = makeTmpDir("gpsh-parsefail-");
		const transcriptPath = join(dir, "transcript.jsonl");
		// This block fails tokenizing on its third line, but the parser's
		// best-effort `extractFilePartial` still recovers `file` from the
		// tokens collected before the error — so parse_status="parse_failed"
		// AND pred.file is non-empty, isolating the parse_failed branch from
		// the (redundant-when-file-is-empty) `!pred.file` branch below it.
		const malformed = assistantLine(
			predictionFence(["  file: src/malformed.ts", "  this is not valid yaml at all!!!"].join("\n")),
		);
		const valid = assistantLine(predictionFence("  file: src/valid-target.ts"));
		writeFileSync(transcriptPath, malformed + valid);

		const result = harvestPredictionsFromTranscript({ cwd: dir, sessionId: "s1", transcriptPath });

		expect(result.persisted).toHaveLength(0);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]?.file_path.endsWith("valid-target.ts")).toBe(true);
		expect(result.skipped[0]?.reason).toBe("non_authoritative_case");
	});
});

describe("harvestPredictionsFromTranscript — E-fresh persistence content", () => {
	function setupEFreshDir(): { dir: string; transcriptPath: string } {
		const dir = makeTmpDir("gpsh-efresh-");
		// A shard-near-source pair makes workspaceSupermodelActive(dir) true,
		// and target.ts / target.graph.ts existing + fresh mtimes makes
		// classifyCase("target.ts", dir) resolve to "E-fresh".
		writeFileSync(join(dir, "target.ts"), "export const x = 1;\n");
		writeFileSync(join(dir, "target.graph.ts"), "{}");
		const transcriptPath = join(dir, "transcript.jsonl");
		writeFileSync(transcriptPath, assistantLine(predictionFence("  file: target.ts")));
		return { dir, transcriptPath };
	}

	function readLastPredictionRow(dir: string): Record<string, unknown> {
		const raw = readFileSync(join(dir, ".interlinked", "graph-predictions.jsonl"), "utf-8");
		const lines = raw.trim().split("\n");
		return JSON.parse(lines.at(-1) ?? "{}");
	}

	it("persists exactly one E-fresh row with the prediction content object intact", () => {
		const { dir, transcriptPath } = setupEFreshDir();

		const result = harvestPredictionsFromTranscript({ cwd: dir, sessionId: "s1", transcriptPath });

		expect(result.persisted).toHaveLength(1);
		expect(result.skipped).toHaveLength(0);

		const row = readLastPredictionRow(dir);
		const prediction = parseWire(row.prediction, wireRecord(wireUnknown), "test JSON value");
		// {} would silently drop these keys entirely from the serialized JSON.
		expect(Object.keys(prediction).sort()).toEqual(["calls", "deps", "impact"]);
		expect(prediction.deps).toBeNull();
		expect(prediction.calls).toBeNull();
		expect(prediction.impact).toBeNull();
	});

	it("writes the fixed tool_input_hash and comparison_status sentinels exactly", () => {
		const { dir, transcriptPath } = setupEFreshDir();

		harvestPredictionsFromTranscript({ cwd: dir, sessionId: "s1", transcriptPath });

		const row = readLastPredictionRow(dir);
		expect(row.tool_input_hash).toBe("");
		expect(row.comparison_status).toBe("pending");
	});
});

describe("readRecentAssistantTexts — resilience to malformed assistant-message shapes", () => {
	it("does not throw and returns [] when an assistant entry has no message field at all", () => {
		const dir = makeTmpDir("gpsh-nomsg-");
		const transcriptPath = join(dir, "transcript.jsonl");
		writeFileSync(transcriptPath, `${JSON.stringify({ type: "assistant" })}\n`);

		let texts: string[] = [];
		expect(() => {
			texts = readRecentAssistantTexts(transcriptPath);
		}).not.toThrow();
		expect(texts).toEqual([]);
	});

	it("does not throw and returns [] when message.content is a non-array object", () => {
		const dir = makeTmpDir("gpsh-objcontent-");
		const transcriptPath = join(dir, "transcript.jsonl");
		const line = JSON.stringify({
			type: "assistant",
			message: { content: { foo: "bar" } },
		});
		writeFileSync(transcriptPath, `${line}\n`);

		let texts: string[] = [];
		expect(() => {
			texts = readRecentAssistantTexts(transcriptPath);
		}).not.toThrow();
		expect(texts).toEqual([]);
	});

	it("ignores non-text content blocks and never surfaces their text", () => {
		const dir = makeTmpDir("gpsh-nontext-");
		const transcriptPath = join(dir, "transcript.jsonl");
		const line = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "image", text: "should not appear" }] },
		});
		writeFileSync(transcriptPath, `${line}\n`);

		const texts = readRecentAssistantTexts(transcriptPath);
		expect(texts).toEqual([]);
	});

	it("joins multiple text blocks in one message with a newline separator", () => {
		const dir = makeTmpDir("gpsh-join-");
		const transcriptPath = join(dir, "transcript.jsonl");
		const line = JSON.stringify({
			type: "assistant",
			message: {
				content: [
					{ type: "text", text: "AAA" },
					{ type: "text", text: "BBB" },
				],
			},
		});
		writeFileSync(transcriptPath, `${line}\n`);

		const texts = readRecentAssistantTexts(transcriptPath);
		expect(texts).toEqual(["AAA\nBBB"]);
	});
});
