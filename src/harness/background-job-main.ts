import { runBackgroundJob } from "./background-job.js";

const [name, file, ...args] = process.argv.slice(2);
const controller = new AbortController();
const abort = (): void => controller.abort();
process.once("SIGTERM", abort);
process.once("SIGINT", abort);

if (!name || !file) {
    process.exitCode = 2;
} else {
    try {
        const result = await runBackgroundJob({ name, file, args }, process.cwd(), controller.signal);
        process.exitCode = result?.code ?? 1;
    } catch {
        process.exitCode = 1;
    }
}
