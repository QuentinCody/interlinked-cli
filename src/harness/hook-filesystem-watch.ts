import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HookCoverageLedger, type HookFileObservation } from "./hook-coverage-ledger.js";
import { FileIdentityCache } from "./hook-file-identity.js";
import { HookCoverageVerification, type HookCoverageChecker } from "./hook-coverage-verification.js";

const ROOT_POLICY_FILES = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "tsconfig.json"];
const LOCAL_POLICY_FILES = ["metric-caps.json", "function-complexity-baseline.json", "guard-rules.json", "check-policy.json"];
const POLICY_NAME = /(?:baseline\.json$|^metric-caps\.json$|^guard-rules\.json$|^check-policy\.json$)/;
type WatchedPaths = Map<string, "policy" | "reservation">;

interface WatchOptions {
    root: string;
    reservations: () => readonly string[];
    reconcileMs?: number;
    onChange?: () => void;
    onError?: (message: string) => void;
    checker?: HookCoverageChecker;
}

function missing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function listed(directory: string): string[] {
    try { return readdirSync(directory); }
    catch (error) { if (missing(error)) return []; throw error; }
}

function selectedPaths(options: WatchOptions, unmeasured: string[]): WatchedPaths {
    const paths: WatchedPaths = new Map();
    const local = join(options.root, ".interlinked");
    for (const file of ROOT_POLICY_FILES) paths.set(join(options.root, file), "policy");
    for (const file of [...LOCAL_POLICY_FILES, ...listed(local).filter(name => POLICY_NAME.test(name))]) paths.set(join(local, file), "policy");
    for (const file of listed(options.root).filter(name => /^tsconfig\..+\.json$/.test(name))) paths.set(join(options.root, file), "policy");
    paths.set(join(options.root, ".claude", "settings.json"), "policy");
    for (const reserved of options.reservations()) {
        if (/[*?\[\]{}]/.test(reserved)) { unmeasured.push(`reservation pattern: ${reserved}`); continue; }
        const path = resolve(options.root, reserved);
        const rel = relative(options.root, path);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) { unmeasured.push(`reservation outside workspace: ${reserved}`); continue; }
        if (!paths.has(path)) paths.set(path, "reservation");
    }
    return paths;
}

function nearestDirectory(path: string): string {
    let directory = dirname(path);
    while (!existsSync(directory) && dirname(directory) !== directory) directory = dirname(directory);
    return directory;
}

/** Directory watches survive atomic replacement. Reconciliation repairs missed
 * notifications; it does not certify lossless kernel delivery or attribution. */
class HookFilesystemWatch {
    readonly ledger: HookCoverageLedger;
    readonly verification: HookCoverageVerification | undefined;
    private readonly watchers = new Map<string, FSWatcher>();
    private selected: WatchedPaths = new Map();
    private unmeasured: string[] = [];
    private stopped = false;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly interval: ReturnType<typeof setInterval>;
    private lastReconciled: string | null = null;
    private readonly identities = new FileIdentityCache();

    constructor(private readonly options: WatchOptions) {
        this.ledger = new HookCoverageLedger(join(options.root, ".interlinked", "hook-coverage.json"));
        this.verification = options.checker ? new HookCoverageVerification({ ledger: this.ledger,
            reconcile: () => this.reconcile(), ready: () => !this.stopped && this.status().readiness === "ready",
            unavailableReason: () => this.status().unmeasured.slice(0, 3).join("; ") }, options.checker) : undefined;
        this.reconcile();
        this.interval = setInterval(() => this.reconcile(), options.reconcileMs ?? 2000);
        this.interval.unref();
    }

    private schedule(): void {
        if (this.stopped || this.timer) return;
        this.timer = setTimeout(() => { this.timer = undefined; this.reconcile(); }, 50);
        this.timer.unref();
    }

    private armDirectory(directory: string): void {
        if (this.watchers.has(directory)) return;
        try {
            const watcher = watch(directory, (_event, name) => {
                if (!name || this.selected.has(join(directory, String(name))) || POLICY_NAME.test(String(name))) this.schedule();
            });
            watcher.on("error", error => { watcher.close(); this.watchers.delete(directory); this.options.onError?.(String(error)); this.schedule(); });
            watcher.unref(); this.watchers.set(directory, watcher);
        } catch (error) { this.unmeasured.push(`watch unavailable: ${directory}: ${String(error)}`); }
    }

    private refreshSelection(): void {
        this.selected = selectedPaths(this.options, this.unmeasured);
        const observation = this.ledger.observation();
        // Deleted water-lines remain in the comparison set.
        for (const [path, value] of Object.entries(observation.files)) {
            if (value.scope === "policy") this.selected.set(path, "policy");
        }
        // Releasing ownership does not verify the last observed write. Keep
        // pending paths measured until their exact current version is checked.
        for (const entry of observation.pending) {
            if (!this.selected.has(entry.path)) this.selected.set(entry.path, entry.scope);
        }
        const directories = new Set([...this.selected.keys()].map(nearestDirectory));
        for (const [directory, watcher] of this.watchers) {
            if (directories.has(directory)) continue;
            watcher.close(); this.watchers.delete(directory);
        }
        for (const directory of directories) this.armDirectory(directory);
    }

    private measureSelected(): void {
        const observations: HookFileObservation[] = [];
        for (const [path, scope] of this.selected) {
            try { observations.push({ path, identity: this.identities.identityOf(path), scope }); }
            catch (error) { this.unmeasured.push(String(error)); }
        }
        this.identities.retain(this.selected.keys());
        this.ledger.observeBatch(observations);
    }

    reconcile(): void {
        if (this.stopped) return;
        this.unmeasured = [];
        const before = this.ledger.summary().generation;
        try {
            this.refreshSelection();
            this.measureSelected();
            this.lastReconciled = new Date().toISOString();
        } catch (error) { this.unmeasured.push(String(error)); }
        if (this.unmeasured.length) this.options.onError?.(this.unmeasured.join("; "));
        if (before !== this.ledger.summary().generation) this.options.onChange?.();
    }

    watchPaths(): string[] { return [...this.selected.keys()].sort(); }
    status() {
        return { readiness: !this.stopped && this.lastReconciled && !this.unmeasured.length ? "ready" : "unmeasured", lastReconciled: this.lastReconciled, unmeasured: [...this.unmeasured], observation: "after_write", attribution: "unknown" };
    }
    stop = (): void => {
        this.stopped = true;
        this.verification?.stop();
        clearInterval(this.interval); clearTimeout(this.timer);
        for (const watcher of this.watchers.values()) watcher.close();
        this.watchers.clear();
    };
}

export function startHookFilesystemWatch(options: WatchOptions): HookFilesystemWatch {
    return new HookFilesystemWatch({ ...options, root: resolve(options.root) });
}
