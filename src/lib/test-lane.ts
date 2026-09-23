import { basename } from "node:path";

export type TestLane = "unit" | "integration" | "e2e" | "base" | "unknown";

export function laneFromConfig(path: string | undefined): TestLane {
    switch (path && basename(path)) {
        case "vitest.e2e.config.ts": return "e2e";
        case "vitest.integration.config.ts": return "integration";
        case "vitest.unit.config.ts": return "unit";
        case "vitest.config.ts": return "base";
        default: return "unknown";
    }
}

/** Command evidence describes an observed invocation, not its exit status. */
export function testLaneOf(command: string): TestLane {
    const text = command.trim().replace(/^(?:env\s+)?(?:[A-Za-z_]\w*=\S+\s+)*/, "");
    const script = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::(e2e|unit|integration))?(?::coverage)?(?=\s|$)/.exec(text);
    if (script) {
        const lane = script[1];
        return lane === "e2e" || lane === "unit" || lane === "integration" ? lane : "base";
    }
    if (!/^(?:(?:npx|bunx)\s+|(?:pnpm|yarn)\s+exec\s+)?(?:\S*\/)?vitest(?:\s|$)/.test(text)) return "unknown";
    const config = /(?:--config|-c)(?:=|\s+)["']?([^\s"']+)/.exec(text)?.[1];
    return config ? laneFromConfig(config) : "base";
}
