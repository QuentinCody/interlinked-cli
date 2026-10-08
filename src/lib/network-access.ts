import { execFile } from "node:child_process";

export type NetworkFailure = "permission-denied" | "proxy-policy" | "dns" | "connection" | "timeout" | "tls" | "tool-unavailable" | "other";

export interface NetworkProbe {
    endpoint: string;
    reachable: boolean;
    http_status?: number;
    failure?: NetworkFailure;
}

/** A probe sends only HEAD to the origin: no credentials, paths or request bodies. */
export function networkOrigins(endpoints: string[]): string[] {
    if (endpoints.length === 0 || endpoints.length > 16) {
        throw new Error("Supply between 1 and 16 HTTP(S) endpoints.");
    }
    return [...new Set(endpoints.map((endpoint) => {
        const url = new URL(endpoint);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.hostname.includes("*")) {
            throw new Error("Endpoints must use HTTP(S) without credentials, query strings or fragments.");
        }
        return url.origin;
    }))];
}

export function classifyNetworkFailure(code: string | number | null | undefined, stderr: string): NetworkFailure {
    if (code === "ENOENT") return "tool-unavailable";
    if (/operation not permitted|permission denied/i.test(stderr)) return "permission-denied";
    if (code === 5 || code === 6) return "dns";
    if (code === 7) return "connection";
    if (code === 28 || code === "ETIMEDOUT") return "timeout";
    if ([35, 51, 58, 60, 77, 80, 82, 83, 90, 91].includes(Number(code))) return "tls";
    return "other";
}

/** Curl honors the host's proxy environment; native fetch may bypass that policy. */
export function probeNetworkOrigin(origin: string, timeoutMs = 5_000): Promise<NetworkProbe> {
    return new Promise((resolve) => {
        execFile("curl", [
            "--disable", "--silent", "--show-error", "--head", "--output", "/dev/null",
            "--dump-header", "-", "--write-out", "\nINTERLINKED_HTTP_STATUS:%{http_code}", "--max-time", String(timeoutMs / 1_000),
            "--connect-timeout", String(timeoutMs / 1_000), "--proto", "=http,https",
            "--url", origin,
        ], { timeout: timeoutMs + 1_000, maxBuffer: 16_384, encoding: "utf8" }, (error, stdout, stderr) => {
            if (/^x-proxy-error:/im.test(stdout)) {
                resolve({ endpoint: origin, reachable: false, failure: "proxy-policy" });
                return;
            }
            const status = Number(stdout.match(/\nINTERLINKED_HTTP_STATUS:(\d{3})$/)?.[1]);
            if (!error && Number.isInteger(status) && status >= 100 && status <= 599) {
                resolve({ endpoint: origin, reachable: true, http_status: status });
                return;
            }
            resolve({ endpoint: origin, reachable: false, failure: classifyNetworkFailure(error?.code, stderr) });
        });
    });
}

export async function checkNetworkAccess(endpoints: string[], env: NodeJS.ProcessEnv = process.env) {
    const origins = networkOrigins(endpoints);
    const probes = await Promise.all(origins.map((origin) => probeNetworkOrigin(origin)));
    return {
        schema_version: 1,
        observed_at: new Date().toISOString(),
        scope: "current-process",
        cwd: process.cwd(),
        runtime: {
            codex_sandbox: env.CODEX_SANDBOX ?? null,
            network_disabled: env.CODEX_SANDBOX_NETWORK_DISABLED === undefined ? null : env.CODEX_SANDBOX_NETWORK_DISABLED === "1",
            thread_id: env.CODEX_THREAD_ID ?? null,
        },
        reachable: probes.every((probe) => probe.reachable),
        probes,
        guidance: "Transport reachability only; HTTP errors still prove access. Run inside the blocked agent's shell. Host sandbox policy, proxy policy and Interlinked decisions are separate. A host-side result does not attest another session.",
    };
}
