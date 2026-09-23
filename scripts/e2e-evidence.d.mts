export function hashBytes(bytes: string | Uint8Array): string;
export function fingerprintBuildInputs(root: string, options?: { mode?: string }): string;
export function fingerprintTestInputs(root: string): Promise<string>;
export function assertE2eBuild(root: string): string;
export function discoveredTests(root: string, configFile: string): Promise<{ tests: string[]; setup: string[] }>;
export function validateE2eEvidence(root: string, reportPath: string, inventory: string[]): Promise<{ schema: 1; lane: "e2e"; passed: true; build: string; tests: string; report: string; inventory: string }>;
