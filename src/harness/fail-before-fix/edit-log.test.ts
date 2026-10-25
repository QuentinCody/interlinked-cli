import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { getCollectionPath } from "../../lib/collection/writer.js";
import { latestEditSession, readEditEvents } from "./edit-log.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function row(root: string, ts: string, session: string, tool: string, action: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ schema: "collection.v1", kind: "tool_event", ts, seq: 1, session_id: session, phase: "post", provider_tool: tool, cwd: root, action, observation: { applied: true }, outcome: "ok", ...extra });
}
function setup(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fbf-log-"))); roots.push(root);
    const live = getCollectionPath(root);
    mkdirSync(dirname(live), { recursive: true });
    const patch = ["*** Begin Patch", `*** Add File: ${root}/src/new.ts`, "+export const n = 1;", "*** Update File: src/sum.ts", "@@", "-return a - b;", "+return a + b;", "*** End Patch"].join("\n");
    writeFileSync(live, [
        row(root, "2026-10-21T10:00:01.000Z", "A", "Edit", { path: `${root}/src/sum.ts`, diff: { hunks: [{ old: "a + b", new: "a - b" }] } }),
        row(root, "2026-10-21T10:00:02.000Z", "B", "Write", { path: `${root}/src/sum.test.ts`, content: "test\n", is_new_file: true }),
        row(root, "2026-10-21T10:00:02.500Z", "A", "Edit", { path: `${root}/src/sum.ts`, diff: { hunks: [{ old: "x", new: "y" }] } }, { phase: "pre" }),
        row(root, "2026-10-21T10:00:03.000Z", "A", "apply_patch", { path: `${root}/src/new.ts`, diff: { hunks: [{ old: "", new: patch }] } }),
        row(root, "2026-10-21T10:00:04.000Z", "A", "Edit", { path: `${root}/src/sum.ts`, diff: { hunks: [{ old: "q", new: "r" }] } }, { outcome: "error" }),
        "{ torn line",
        row(root, "2026-10-21T10:00:05.000Z", "A", "Edit", { path: "/elsewhere/src/sum.ts", diff: { hunks: [{ old: "a", new: "b" }] } }),
    ].join("\n") + "\n");
    mkdirSync(join(dirname(live), "archive"), { recursive: true });
    writeFileSync(join(dirname(live), "archive", "collection-0001.jsonl.gz"), gzipSync(row(root, "2026-10-20T09:00:00.000Z", "C", "Edit", { path: `${root}/src/sum.ts`, diff: { hunks: [{ old: "a * b", new: "a + b" }] } }) + "\n"));
    return root;
}

describe("readEditEvents — positive", () => {
    it("P1: applied post edits in log order, a multi-file patch split per file, paths project-relative", async () => {
        const root = setup();
        const events = await readEditEvents({ root, paths: new Set(["src/sum.ts", "src/new.ts", "src/sum.test.ts"]), archives: false });
        expect(events.map(event => [event.ts.slice(17, 19), event.session, event.kind, event.path])).toEqual([
            ["01", "A", "hunks", "src/sum.ts"],
            ["02", "B", "write", "src/sum.test.ts"],
            ["03", "A", "patch", "src/new.ts"],
            ["03", "A", "patch", "src/sum.ts"],
        ]);
    });

    it("P2: archive segments are read on request and come first in time", async () => {
        const root = setup();
        const events = await readEditEvents({ root, paths: new Set(["src/sum.ts"]), archives: true });
        expect(events.map(event => event.session)).toEqual(["C", "A", "A"]);
    });

    it("P3: the latest session with an applied edit is found", async () => {
        expect(await latestEditSession(setup())).toBe("A");
    });
});

// The timeline is derived from the runner's transcript; it still holds calls the daemon never saw (cold-fallback
// allows during a daemon stall, 2026-10-22). Row shapes follow `.interlinked/timeline.jsonl` (timeline.v1).
function timelineRow(root: string, ts: string, session: string, category: "tool_use" | "tool_result", extra: Record<string, unknown>): string {
    return JSON.stringify({ schema: "timeline.v1", ts, session, provider: "claude-code", cwd: root, category, ...extra });
}
function withTimeline(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fbf-log-"))); roots.push(root);
    const live = getCollectionPath(root);
    mkdirSync(dirname(live), { recursive: true });
    writeFileSync(live, row(root, "2026-10-21T10:00:05.000Z", "A", "Edit", { path: `${root}/src/sum.ts`, diff: { hunks: [{ old: "a", new: "b" }] } }, { tool_use_id: "t-known" }) + "\n");
    const use = (ts: string, id: string, tool: string, input: Record<string, unknown>, session = "A") => timelineRow(root, ts, session, "tool_use", { tool_use_id: id, tool_name: tool, tool_input: input });
    const result = (ts: string, id: string, isError: boolean, session = "A") => timelineRow(root, ts, session, "tool_result", { tool_use_id: id, is_error: isError });
    writeFileSync(join(dirname(live), "timeline.jsonl"), [
        use("2026-10-21T10:00:01.000Z", "t-lost", "Write", { file_path: `${root}/src/lost.ts`, content: "lost\n" }),
        result("2026-10-21T10:00:01.500Z", "t-lost", false),
        use("2026-10-21T10:00:02.000Z", "t-blocked", "Edit", { file_path: `${root}/src/sum.ts`, old_string: "x", new_string: "y" }),
        result("2026-10-21T10:00:02.500Z", "t-blocked", true),
        use("2026-10-21T10:00:04.000Z", "t-known", "Edit", { file_path: `${root}/src/sum.ts`, old_string: "a", new_string: "b" }),
        result("2026-10-21T10:00:04.500Z", "t-known", false),
        use("2026-10-21T10:00:06.000Z", "t-multi", "MultiEdit", { file_path: "src/sum.ts", edits: [{ old_string: "b", new_string: "c" }, { old_string: "c", new_string: "d" }] }),
        result("2026-10-21T10:00:06.500Z", "t-multi", false),
        use("2026-10-21T10:00:07.000Z", "t-unanswered", "Edit", { file_path: `${root}/src/sum.ts`, old_string: "d", new_string: "e" }),
        use("2026-10-21T10:00:08.000Z", "t-read", "Read", { file_path: `${root}/src/sum.ts` }),
        result("2026-10-21T10:00:08.500Z", "t-read", false),
        use("2026-10-21T10:00:09.000Z", "t-other", "Write", { file_path: `${root}/src/other.ts`, content: "other\n" }, "B"),
        result("2026-10-21T10:00:09.500Z", "t-other", false, "B"),
        "{ torn line",
    ].join("\n") + "\n");
    return root;
}

describe("readEditEvents — calls the collection missed, from the timeline (positive)", () => {
    it("P4: an applied Write and MultiEdit with no collection row are filled in time order and marked as timeline edits", async () => {
        const events = await readEditEvents({ root: withTimeline(), session: "A", archives: false });
        expect(events.map(event => [event.ts.slice(17, 19), event.kind, event.path, event.source ?? "collection"])).toEqual([
            ["01", "write", "src/lost.ts", "timeline"],
            ["05", "hunks", "src/sum.ts", "collection"],
            ["06", "hunks", "src/sum.ts", "timeline"],
        ]);
        expect(events.at(-1)).toMatchObject({ kind: "hunks", hunks: [{ old: "b", new: "c" }, { old: "c", new: "d" }] });
    });
});

describe("readEditEvents — calls the collection missed, from the timeline (negative)", () => {
    it("N3: a failed or blocked call, a call the collection recorded, a call with no result and a read are never filled; another session is filtered", async () => {
        const root = withTimeline();
        const ids = (await readEditEvents({ root, session: "A", archives: false })).filter(event => event.source === "timeline").map(event => event.path);
        expect(ids).toEqual(["src/lost.ts", "src/sum.ts"]);
        const all = await readEditEvents({ root, archives: false });
        expect(all.filter(event => event.source === "timeline").map(event => event.session)).toEqual(["A", "A", "B"]);
    });
});

describe("readEditEvents — negative", () => {
    it("N1: pre events, failed edits, torn lines and paths outside the project never become events", async () => {
        const root = setup();
        const events = await readEditEvents({ root, archives: false });
        expect(events.some(event => event.path.includes("elsewhere"))).toBe(false);
        expect(events.filter(event => event.kind === "hunks").map(event => event.hunks)).toEqual([[{ old: "a + b", new: "a - b" }]]);
    });

    it("N2: a project without a log has no events and no session", async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "fbf-log-"))); roots.push(root);
        expect(await readEditEvents({ root, archives: true })).toEqual([]);
        expect(await latestEditSession(root)).toBeNull();
    });
});
