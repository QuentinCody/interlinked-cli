// Permission proposals are observational hints, never grants. Shared by both
// learner observers; shell composition and interpreters are not generalized.
import { readToolString } from "./tool-input-values.js";
import type { JsonObject } from "../../lib/json-types.js";
import { isBash } from "./tool-classifiers.js";

const SIMPLE_COMMANDS = new Set(["ls", "cat", "pwd", "rg", "grep", "head", "tail", "wc"]);
const GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files"]);

export function extractPermissionPattern(toolName: string, toolInput: JsonObject): string | null {
    if (isBash(toolName)) return extractBashPattern(readToolString(toolInput.command));
    if (toolName !== "WebFetch" && toolName !== "web_fetch") return null;
    try {
        const url = new URL(readToolString(toolInput.url));
        if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        return url.hostname ? "WebFetch(domain:" + url.hostname + ")" : null;
    } catch {
        return null;
    }
}

/** Restricted proposal grammar, not a shell parser or safe-to-execute verdict. */
function extractBashPattern(command: string): string | null {
    if (!/^[\w ./,:=@+-]+$/.test(command)) return null;
    const [executable, subcommand] = command.trim().split(/ +/);
    if (!executable) return null;
    if (SIMPLE_COMMANDS.has(executable)) return "Bash(" + executable + " *)";
    if (executable === "git" && subcommand && GIT_SUBCOMMANDS.has(subcommand)) {
        return "Bash(git " + subcommand + " *)";
    }
    return null;
}
