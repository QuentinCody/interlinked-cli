import { join } from "node:path";

/**
 * The directory a local verify run scans, or undefined for the whole project.
 *
 * `--subdir` narrows a local run the same way it narrows a remote clone: the
 * scan root is the subdirectory of the target, or of the project when no target
 * is given. Before this, a local run accepted the option and ignored it.
 */
export function localScanTarget(opts: { target?: string | undefined; subdir?: string | undefined }): string | undefined {
	if (opts.target && opts.subdir) return join(opts.target, opts.subdir);
	return opts.target || opts.subdir || undefined;
}
