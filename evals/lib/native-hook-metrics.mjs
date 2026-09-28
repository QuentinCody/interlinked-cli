// Native transcript rendering is distinct from terminal output and billed usage.
function renderedText(row) {
    if (!Array.isArray(row.rendered)) return "";
    return row.rendered.map(part => typeof part.content === "string" ? part.content : "").join("\n");
}

function normalize(text) {
    return text.replace(/\/(?:private\/)?tmp\/hce-[^/\s:]+/g, "<fixture>").replace(/\(\d+(?:,\d+)*\)(?=:)/g, "(<line>)");
}

function countRendered(rows, lastAssistant) {
    const seenIds = new Set(), fingerprints = new Set();
    let bytes = 0, messages = 0, repeatedBytes = 0;
    const byEvent = {};
    for (const [index, row] of rows.entries()) {
        if (index >= lastAssistant || !row.attachment?.type?.startsWith("hook_") || seenIds.has(row.uuid)) continue;
        seenIds.add(row.uuid);
        const text = renderedText(row);
        if (!text.includes("[interlinked")) continue;
        const size = Buffer.byteLength(text), fingerprint = normalize(text), event = row.attachment.hookEvent ?? "unknown";
        bytes += size; messages++;
        byEvent[event] = (byEvent[event] ?? 0) + size;
        if (fingerprints.has(fingerprint)) repeatedBytes += size;
        fingerprints.add(fingerprint);
    }
    return { rendered_hook_bytes: bytes, rendered_hook_messages: messages, repeated_rendered_bytes: repeatedBytes, rendered_bytes_by_event: byEvent };
}

/** Count each rendered attachment once, only when a later assistant response exists. */
export function nativeHookMetrics(rows) {
    const lastAssistant = rows.findLastIndex(row => row.type === "assistant");
    const hookDurations = [], commandSizes = {}, seen = new Set();
    for (const row of rows) {
        const attachment = row.attachment;
        if (!attachment?.type?.startsWith("hook_") || seen.has(row.uuid)) continue;
        seen.add(row.uuid);
        if (typeof attachment.durationMs === "number") hookDurations.push(attachment.durationMs);
        if (typeof attachment.command === "string") {
            const event = attachment.hookEvent ?? "unknown";
            commandSizes[event] = Math.max(commandSizes[event] ?? 0, Buffer.byteLength(attachment.command));
        }
    }
    return { ...countRendered(rows, lastAssistant), hook_durations_ms: hookDurations, max_command_bytes_by_event: commandSizes,
        qualification: "Native rendered Interlinked hook context preceding a later assistant response; includes provider wrappers, counts each attachment once. This is not a tokenizer or billing measure." };
}
