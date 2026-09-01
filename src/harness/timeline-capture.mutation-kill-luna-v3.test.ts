import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    captureAgentTranscript,
    captureTimeline,
} from "./timeline-capture.js";
import { timelinePath } from "./timeline-writer.js";
import type { HarnessEvent } from "./types/events.js";

function assistantLine(uuid: string, text: string): string {
    return `${JSON.stringify({
        type: "assistant",
        uuid,
        timestamp: "2026-08-20T00:00:00.000Z",
        sessionId: "session",
        message: { model: "test-model", content: [{ type: "text", text }] },
    })}\n`;
}

function event(cwd: string, transcriptPath: string): HarnessEvent {
    return {
        hook_event: "Stop",
        session_id: "session",
        agent_source: "claude",
        timestamp: "2026-08-20T00:00:00.000Z",
        cwd,
        transcript_path: transcriptPath,
    };
}

function texts(cwd: string): string[] {
    if (!existsSync(timelinePath(cwd))) return [];
    return readFileSync(timelinePath(cwd), "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { text: string }).text);
}

describe("timeline capture mutation contracts", () => {
    const directories: string[] = [];

    afterEach(() => {
        for (const directory of directories.splice(0)) {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    // test-contract: an empty transcript does not create an empty timeline.
    it("does not append when a live drain has no records", () => {
        const cwd = mkdtempSync(join(tmpdir(), "timeline-empty-"));
        directories.push(cwd);
        const transcript = join(cwd, "transcript.jsonl");
        writeFileSync(transcript, "");
        captureTimeline(event(cwd, transcript), cwd);
        expect(existsSync(timelinePath(cwd))).toBe(false);
    });

    // test-contract: an empty agent drain reports zero and leaves storage untouched.
    it("does not append when an agent transcript has no records", () => {
        const cwd = mkdtempSync(join(tmpdir(), "agent-empty-"));
        directories.push(cwd);
        const transcript = join(cwd, "agent.jsonl");
        writeFileSync(transcript, "");
        expect(captureAgentTranscript(transcript, cwd)).toBe(0);
        expect(existsSync(timelinePath(cwd))).toBe(false);
    });

    // test-contract: a valid cursor path resumes at its recorded byte offset.
    it("accepts a valid cursor path and resumes from its offset", () => {
        const cwd = mkdtempSync(join(tmpdir(), "cursor-path-"));
        directories.push(cwd);
        const transcript = join(cwd, "transcript.jsonl");
        const first = assistantLine("one", "one");
        writeFileSync(transcript, first + assistantLine("two", "two"));
        mkdirSync(join(cwd, ".interlinked"), { recursive: true });
        writeFileSync(
            join(cwd, ".interlinked", "timeline-cursor.json"),
            JSON.stringify({ path: transcript, offset: Buffer.byteLength(first) }),
        );
        captureTimeline(event(cwd, transcript), cwd);
        expect(texts(cwd)).toEqual(["two"]);
    });

    // test-contract: a numeric cursor offset is accepted as a valid resume position.
    it("accepts a numeric cursor offset", () => {
        const cwd = mkdtempSync(join(tmpdir(), "cursor-offset-"));
        directories.push(cwd);
        const transcript = join(cwd, "transcript.jsonl");
        const first = assistantLine("one", "one");
        writeFileSync(transcript, first + assistantLine("two", "two"));
        mkdirSync(join(cwd, ".interlinked"), { recursive: true });
        writeFileSync(
            join(cwd, ".interlinked", "timeline-cursor.json"),
            JSON.stringify({ path: transcript, offset: Buffer.byteLength(first) }),
        );
        captureTimeline(event(cwd, transcript), cwd);
        expect(texts(cwd)).toEqual(["two"]);
    });

    // test-contract: a cursor for another transcript starts the new transcript at byte zero.
    it("resets when the cursor path differs from the transcript", () => {
        const cwd = mkdtempSync(join(tmpdir(), "cursor-reset-"));
        directories.push(cwd);
        const transcript = join(cwd, "transcript.jsonl");
        const first = assistantLine("one", "one");
        writeFileSync(transcript, first + assistantLine("two", "two"));
        mkdirSync(join(cwd, ".interlinked"), { recursive: true });
        writeFileSync(
            join(cwd, ".interlinked", "timeline-cursor.json"),
            JSON.stringify({ path: join(cwd, "other.jsonl"), offset: Buffer.byteLength(first) }),
        );
        captureTimeline(event(cwd, transcript), cwd);
        expect(texts(cwd)).toEqual(["one", "two"]);
    });
});
