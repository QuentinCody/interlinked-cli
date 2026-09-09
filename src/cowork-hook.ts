import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runCoworkHook } from "./lib/cowork/runtime.js";
import { encodeCoworkVerdict } from "./lib/cowork/native.js";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;

async function readInput(): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_INPUT_BYTES) throw new Error("Cowork hook input exceeds 2 MiB");
        chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main(): Promise<void> {
    const argument = process.argv.indexOf("--event");
    const event = argument >= 0 ? process.argv[argument + 1] ?? "unknown" : "unknown";
    const root = process.env.CLAUDE_PLUGIN_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
    try {
        const output = await runCoworkHook(root, await readInput(), event);
        if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch {
        // Native inputs and remote errors may contain secrets. Report a fixed
        // failure class; never reflect raw exception messages into receipts.
        const output = encodeCoworkVerdict(event, { decision: "deny", checks: [], unmeasured: ["hook_runtime"], reason: "Interlinked Cowork policy NOT CHECKED: runtime/configuration/bridge unavailable." });
        if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
        process.stderr.write("[interlinked:cowork] NOT CHECKED: hook runtime/configuration/bridge unavailable.\n");
        process.exitCode = event === "PreToolUse" ? 2 : 1;
    }
}

await main();
