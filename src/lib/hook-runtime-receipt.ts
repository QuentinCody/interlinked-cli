import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "./json-types.js";

export const HOOK_RUNTIME_RECEIPT_FILE = "hook-runtime.json";

interface HookRuntimeObservation {
	observed_at: string;
	native_event: string;
	definition_sha256?: string;
}

interface HookRuntimeReceipt {
	schema_version: "1";
	providers: Record<string, HookRuntimeObservation>;
}

interface RecordHookRuntimeOptions {
	dataDir: string;
	provider: string;
	nativeEvent: string;
	definitionPath?: string;
	now?: () => Date;
}

/** Best-effort proof that a configured provider actually executed an
 * Interlinked hook. This intentionally records no payload or user content. */
export function recordHookRuntime(opts: RecordHookRuntimeOptions): void {
	if (!isSafeProviderKey(opts.provider)) return;
	const path = join(opts.dataDir, HOOK_RUNTIME_RECEIPT_FILE);
	const receipt = readHookRuntimeReceipt(path) ?? emptyReceipt();
	const observation: HookRuntimeObservation = {
		observed_at: (opts.now ?? (() => new Date()))().toISOString(),
		native_event: opts.nativeEvent,
	};
	const definitionHash = opts.definitionPath
		? hashHookDefinition(opts.definitionPath)
		: undefined;
	if (definitionHash) observation.definition_sha256 = definitionHash;
	receipt.providers[opts.provider] = observation;
	writeReceiptAtomically(path, receipt);
}

export function readHookRuntimeReceipt(path: string): HookRuntimeReceipt | null {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isJsonObject(value) || value.schema_version !== "1") return null;
		if (!isJsonObject(value.providers)) return null;
		return value as unknown as HookRuntimeReceipt;
	} catch {
		return null;
	}
}

export function hashHookDefinition(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return undefined;
	}
}

function emptyReceipt(): HookRuntimeReceipt {
	return { schema_version: "1", providers: {} };
}

function isSafeProviderKey(provider: string): boolean {
	return /^[a-z0-9][a-z0-9-]{0,63}$/.test(provider);
}

function writeReceiptAtomically(path: string, receipt: HookRuntimeReceipt): void {
	const tempPath = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tempPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
		renameSync(tempPath, path);
	} catch {
		try {
			unlinkSync(tempPath);
		} catch {
			// Best effort: hook execution must never fail because diagnostics did.
		}
	}
}
