import { isIP } from "node:net";

// Only explicit loopback destinations qualify. Private/LAN addresses still leave
// the machine. Unknown options retain the network guard: proxies, redirects,
// alternate resolution and config files can change the peer.
const CURL_FLAGS = new Set([
    "--silent", "--show-error", "--fail", "--fail-with-body", "--head",
    "--include", "--insecure", "--verbose", "--compressed", "--get",
    "--globoff", "--no-buffer", "--disable", "--ipv4", "--ipv6",
]);
const CURL_VALUES = new Set([
    "--request", "--header", "--data", "--data-raw", "--data-binary",
    "--data-urlencode", "--data-ascii", "--json", "--output", "--user",
    "--connect-timeout", "--max-time", "--write-out", "--url",
]);

function isLoopbackHost(host: string): boolean {
    const bare = host.toLowerCase().replace(/^\[|\]$/g, "");
    return bare === "localhost" || bare === "localhost." || bare === "::1" ||
        (isIP(bare) === 4 && bare.startsWith("127."));
}

function isLoopbackUrl(value: string): boolean {
    // Reject expansions and URL globbing before WHATWG normalization. IPv6
    // brackets are permitted; only a parsed loopback address can pass below.
    if (/[\s\\${}`]/.test(value)) return false;
    try {
        const url = new URL(value.includes("://") ? value : `http://${value}`);
        return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname);
    } catch {
        return false;
    }
}

/** Number of following tokens consumed, or null for an unsupported option. */
function curlOptionWidth(token: string): number | null {
    if (CURL_FLAGS.has(token)) return 0;
    if (token.startsWith("--")) {
        const name = token.split("=", 1)[0] ?? "";
        if (!CURL_VALUES.has(name)) return null;
        return token.includes("=") ? 0 : 1;
    }
    // A value-taking short flag consumes the remainder or the next token.
    const valueFlag = /^-[sSfIikvGgNq46]*[XHdoumw](.*)$/.exec(token);
    if (valueFlag) return valueFlag[1] === "" ? 1 : 0;
    return /^-[sSfIikvGgNq46]+$/.test(token) ? 0 : null;
}

interface CurlArgument {
    width: number;
    url?: string;
}

function curlArgument(token: string, next: string | undefined, positional: boolean): CurlArgument | null {
    if (positional || !token.startsWith("-")) return { width: 0, url: token };
    const width = curlOptionWidth(token);
    if (width === null || (width === 1 && next === undefined)) return null;
    if (token === "--url") return { width, url: next ?? "" };
    if (token.startsWith("--url=")) return { width, url: token.slice(6) };
    return { width };
}

function isLoopbackCurl(args: string[]): boolean {
    const urls: string[] = [];
    let positional = false;
    for (let i = 0; i < args.length; i++) {
        const token = args[i] ?? "";
        if (!positional && token === "--") { positional = true; continue; }
        const argument = curlArgument(token, args[i + 1], positional);
        if (!argument) return false;
        if (argument.url !== undefined) urls.push(argument.url);
        i += argument.width;
    }
    return urls.length > 0 && urls.every(isLoopbackUrl);
}

function isLoopbackNetcat(args: string[]): boolean {
    const positionals: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const token = args[i] ?? "";
        if (/^-[zvn46u]+$/.test(token)) continue;
        if (token === "-w" && /^\d+$/.test(args[i + 1] ?? "")) { i++; continue; }
        if (token.startsWith("-")) return false;
        positionals.push(token);
    }
    return positionals.length === 2 && isLoopbackHost(positionals[0] ?? "") &&
        /^\d+$/.test(positionals[1] ?? "");
}

function isLoopbackWget(args: string[]): boolean {
    // wget follows redirects by default, unlike curl. Only the explicit
    // no-redirect form can qualify for this static destination exception.
    if (!args.includes("--max-redirect=0")) return false;
    const flags = new Set(["--max-redirect=0", "-qO-", "-O-", "-q"]);
    const urls = args.filter((arg) => !flags.has(arg));
    return urls.length > 0 && urls.every(isLoopbackUrl);
}

/** Whether a tokenized network invocation has only understood loopback peers. */
export function isLoopbackNetworkCommand(head: string, args: string[]): boolean {
    if (head === "curl") return isLoopbackCurl(args);
    if (head === "wget") return isLoopbackWget(args);
    if (["nc", "ncat", "netcat"].includes(head)) return isLoopbackNetcat(args);
    return false;
}
