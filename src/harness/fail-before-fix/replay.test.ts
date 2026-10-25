import { describe, expect, it } from "vitest";
import { applyEdit, replayFile, type EditEvent } from "./replay.js";

const at = (n: number) => `2026-10-21T10:00:${String(n).padStart(2, "0")}.000Z`;
function hunks(n: number, session: string, pairs: Array<[string, string]>): EditEvent {
    return { kind: "hunks", path: "src/sum.ts", ts: at(n), seq: n, session, hunks: pairs.map(([old, next]) => ({ old, new: next })) };
}
function write(n: number, session: string, content: string): EditEvent {
    return { kind: "write", path: "src/sum.ts", ts: at(n), seq: n, session, content };
}

describe("applyEdit — positive", () => {
    it("P1: a Write sets the bytes; a hunk replaces its one anchor; an empty anchor creates an absent file", () => {
        expect(applyEdit("a", write(1, "s", "b"))).toEqual({ ok: true, state: "b" });
        expect(applyEdit("x = 1;\n", hunks(1, "s", [["1", "2"]]))).toEqual({ ok: true, state: "x = 2;\n" });
        expect(applyEdit(null, hunks(1, "s", [["", "new file\n"]]))).toEqual({ ok: true, state: "new file\n" });
    });

    it("P2: an anchor that occurs several times is replaced everywhere (Edit replace_all); the replay's final check decides", () => {
        expect(applyEdit("a a", hunks(1, "s", [["a", "b"]]))).toEqual({ ok: true, state: "b b" });
    });

    it("P3: a V4A section is applied through the shared patch reconstruction; an added file ends with a newline", () => {
        const add = { kind: "patch" as const, path: "src/n.ts", ts: at(1), seq: 1, session: "s", section: { path: "src/n.ts", op: "add" as const, body: ["+export const n = 1;"] } };
        expect(applyEdit(null, add)).toEqual({ ok: true, state: "export const n = 1;\n" });
        const del = { ...add, section: { path: "src/n.ts", op: "delete" as const, body: [] } };
        expect(applyEdit("x\n", del)).toEqual({ ok: true, state: null });
    });
});

describe("applyEdit — negative", () => {
    it("N1: a missing anchor, an empty anchor on an existing file, and a hunk on an absent file are refused with the reason", () => {
        expect(applyEdit("x", hunks(1, "s", [["y", "z"]]))).toEqual({ ok: false, reason: "anchor not found" });
        expect(applyEdit("x", hunks(1, "s", [["", "z"]]))).toEqual({ ok: false, reason: "empty anchor on an existing file" });
        expect(applyEdit(null, hunks(1, "s", [["x", "z"]]))).toEqual({ ok: false, reason: "edit of an absent file" });
    });
});

describe("replayFile", () => {
    it("P4: the pre-session bytes are the state just before the target session's first edit; other sessions' edits are replayed too", () => {
        const events = [hunks(1, "other", [["a", "b"]]), hunks(2, "target", [["b", "c"]]), hunks(3, "other", [["c", "d"]])];
        expect(replayFile("src/sum.ts", "a", events, "target", "d")).toEqual({ path: "src/sum.ts", ok: true, preSession: "b", touched: true });
    });

    it("P5: a file the target session created has no pre-session bytes (null)", () => {
        expect(replayFile("src/sum.ts", null, [write(1, "target", "x")], "target", "x")).toEqual({ path: "src/sum.ts", ok: true, preSession: null, touched: true });
    });

    it("N2: a replay that does not reproduce the current bytes is unavailable, never a pre-session state", () => {
        const result = replayFile("src/sum.ts", "a", [hunks(1, "target", [["a", "b"]])], "target", "b-but-edited-elsewhere");
        expect(result).toEqual({ path: "src/sum.ts", ok: false, touched: true, reason: "the logged edits do not reproduce the current bytes (a change outside the log)" });
    });

    it("N3: a refused edit makes the file unavailable and names the event", () => {
        const result = replayFile("src/sum.ts", "a", [hunks(1, "target", [["zzz", "b"]])], "target", "b");
        expect(result).toEqual({ path: "src/sum.ts", ok: false, touched: true, reason: `edit at ${at(1)} (target): anchor not found` });
    });

    it("N4: a file the target session never edited is not touched", () => {
        expect(replayFile("src/sum.ts", "a", [hunks(1, "other", [["a", "b"]])], "target", "b")).toEqual({ path: "src/sum.ts", ok: true, touched: false });
    });
});
