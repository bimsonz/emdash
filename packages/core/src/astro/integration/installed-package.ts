import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The version of `name` installed for the project at `root`: the nearest
 * `node_modules/<name>/package.json` at or above `root`, which also finds a
 * package hoisted to a workspace root. `undefined` when it is not installed or
 * its `package.json` can't be read.
 */
export function installedPackageVersion(root: URL, name: string): string | undefined {
	for (let dir = fileURLToPath(root); dir !== dirname(dir); dir = dirname(dir)) {
		const file = join(dir, "node_modules", name, "package.json");
		if (!existsSync(file)) continue;
		try {
			const pkg: unknown = JSON.parse(readFileSync(file, "utf8"));
			return typeof pkg === "object" &&
				pkg !== null &&
				"version" in pkg &&
				typeof pkg.version === "string"
				? pkg.version
				: undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}
