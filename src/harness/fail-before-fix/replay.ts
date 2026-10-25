// ===========================================
// fail-before-fix — replay of logged edits to recover pre-session bytes
// ===========================================
// The harness log records every applied edit (Write content, Edit/MultiEdit hunks, apply_patch envelopes). Starting
// from a known base (git HEAD, or an absent file), replaying every logged edit to a file must reproduce the bytes
// on disk; when it does, the state just before the target session's first edit is that session's pre-session code.
// When it does not (a change outside the log, a lost post event, an unlogged writer), the file is unavailable:
// a replay is evidence only when it reproduces the current bytes (E66, 2026-10-21: 146 of 156 files did).

import { reconstructAfterContent, type ApplyPatchSection } from "../apply-patch-content.js";

/** `source: "timeline"` marks an applied call the collection log missed, recovered from the transcript timeline. */
interface EditBase { path: string; ts: string; seq: number; session: string; source?: "timeline"; }
export type EditEvent =
    | (EditBase & { kind: "write"; content: string })
    | (EditBase & { kind: "hunks"; hunks: Array<{ old: string; new: string }> })
    | (EditBase & { kind: "patch"; section: ApplyPatchSection });
/** File bytes, or null for an absent file. */
export type FileState = string | null;
export type EditResult = { ok: true; state: FileState } | { ok: false; reason: string };

function applyHunks(state: FileState, pairs: ReadonlyArray<{ old: string; new: string }>): EditResult {
    let current = state;
    for (const { old, new: next } of pairs) {
        if (old === "") {
            if (current !== null && current !== "") return { ok: false, reason: "empty anchor on an existing file" };
            current = next;
            continue;
        }
        if (current === null) return { ok: false, reason: "edit of an absent file" };
        if (!current.includes(old)) return { ok: false, reason: "anchor not found" };
        current = current.split(old).join(next); // several occurrences = replace_all; the final byte check decides
    }
    return { ok: true, state: current };
}

function applySection(state: FileState, section: ApplyPatchSection): EditResult {
    if (section.op === "delete") return { ok: true, state: null };
    const after = reconstructAfterContent(section, state ?? "");
    if (after === null) return { ok: false, reason: `patch section for ${section.path} does not apply` };
    return { ok: true, state: section.op === "add" && !after.endsWith("\n") ? `${after}\n` : after };
}

export function applyEdit(state: FileState, event: EditEvent): EditResult {
    if (event.kind === "write") return { ok: true, state: event.content };
    if (event.kind === "hunks") return applyHunks(state, event.hunks);
    return applySection(state, event.section);
}

export type FileReplay =
    | { path: string; ok: true; touched: false }
    | { path: string; ok: true; touched: true; preSession: FileState }
    | { path: string; ok: false; touched: boolean; reason: string };

/** Replays `events` (all sessions, log order) from `base`; the result is trusted only when it ends at `current`. */
export function replayFile(path: string, base: FileState, events: readonly EditEvent[], session: string, current: FileState): FileReplay {
    let state = base, preSession: FileState | undefined;
    for (const event of events) {
        if (event.session === session && preSession === undefined) preSession = state;
        const result = applyEdit(state, event);
        if (!result.ok) return { path, ok: false, touched: preSession !== undefined, reason: `edit at ${event.ts} (${event.session}): ${result.reason}` };
        state = result.state;
    }
    if (preSession === undefined) return { path, ok: true, touched: false };
    if (state !== current) return { path, ok: false, touched: true, reason: "the logged edits do not reproduce the current bytes (a change outside the log)" };
    return { path, ok: true, touched: true, preSession };
}
