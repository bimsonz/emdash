import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import cloudflare from "@astrojs/cloudflare";
import type { AstroIntegration } from "astro";
import emdash from "emdash/astro";
import { afterEach, describe, expect, it, vi } from "vitest";

type SetupHook = NonNullable<AstroIntegration["hooks"]["astro:config:setup"]>;
type ImageService = NonNullable<Parameters<typeof cloudflare>[0]>["imageService"];
type VitePlugin = { name?: string; load?: unknown };

const CONFIG_PLUGIN = "virtual:astro-cloudflare:config";
const PACKAGE_NODE_MODULES = fileURLToPath(new URL("../node_modules", import.meta.url));
const ADAPTER_VERSION = (
	JSON.parse(
		readFileSync(
			createRequire(import.meta.url).resolve("@astrojs/cloudflare/package.json"),
			"utf8",
		),
	) as { version: string }
).version;

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function flatten(plugins: unknown): unknown[] {
	return Array.isArray(plugins) ? plugins.flatMap(flatten) : [plugins];
}

/**
 * Runs the real adapter's `astro:config:setup`, then EmDash's on the config it
 * leaves, as Astro does (the adapter always runs first). Returns the image
 * service EmDash installs, the signing flag it serializes and its warnings.
 * The project links this package's `node_modules`, so the adapter is installed
 * there as in a real site.
 */
async function buildWith(
	imageService: ImageService | undefined,
	{
		command = "build",
		alterConfigPlugin,
	}: { command?: "build" | "dev"; alterConfigPlugin?: (plugin: VitePlugin) => void } = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "emdash-image-signing-"));
	roots.push(dir);
	symlinkSync(PACKAGE_NODE_MODULES, join(dir, "node_modules"), "dir");
	writeFileSync(
		join(dir, "wrangler.jsonc"),
		JSON.stringify({ name: "probe", main: "x.js", compatibility_date: "2026-01-01" }),
	);
	const root = pathToFileURL(`${dir}/`);
	const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
	const adapter = cloudflare(imageService === undefined ? {} : { imageService });
	let config: Record<string, unknown> = {
		root,
		srcDir: new URL("src/", root),
		base: "/",
		build: { assets: "_astro" },
		experimental: {},
		security: {},
		trailingSlash: "ignore",
		integrations: [{ name: "@astrojs/react", hooks: {} }],
		image: { service: { entrypoint: "astro/assets/services/sharp", config: {} } },
		vite: {},
		adapter,
	};
	await (adapter.hooks["astro:config:setup"] as SetupHook)({
		command,
		config,
		logger,
		addWatchFile: vi.fn(),
		updateConfig: (update: Record<string, unknown>) => {
			config = { ...config, ...update };
			return config;
		},
	} as never);
	if (alterConfigPlugin) {
		const plugins = flatten((config.vite as { plugins?: unknown } | undefined)?.plugins);
		const plugin = plugins.find(
			(candidate): candidate is VitePlugin =>
				typeof candidate === "object" &&
				candidate !== null &&
				(candidate as VitePlugin).name === CONFIG_PLUGIN,
		);
		if (!plugin) throw new Error(`the adapter registered no ${CONFIG_PLUGIN} plugin`);
		alterConfigPlugin(plugin);
	}

	const updateConfig = vi.fn();
	await (emdash({ images: { signedUrls: true } }).hooks["astro:config:setup"] as SetupHook)({
		command,
		config,
		logger,
		injectRoute: vi.fn(),
		addMiddleware: vi.fn(),
		updateConfig,
	} as never);
	const update = updateConfig.mock.calls[0]?.[0] as {
		image?: { service?: unknown };
		vite?: { plugins?: Array<{ name?: string; load: (id: string) => unknown }> };
	};
	const virtualModules = update.vite?.plugins?.find(
		(plugin) => plugin?.name === "emdash-virtual-modules",
	);
	const runtimeConfig = JSON.parse(
		String(virtualModules?.load("\0virtual:emdash/config"))
			.replace(/^export default /, "")
			.replace(/;$/, ""),
	) as { imageSigning?: boolean };
	const warnings = logger.warn.mock.calls.map(([message]) => String(message));
	return { service: update.image?.service, imageSigning: runtimeConfig.imageSigning, warnings };
}

describe("images.signedUrls under each @astrojs/cloudflare image mode", () => {
	it.each([
		["the default", undefined],
		['"cloudflare-binding"', "cloudflare-binding" as const],
		['{ build: "cloudflare-binding" }', { build: "cloudflare-binding" as const }],
	])("wraps the workerd service under %s", async (_mode, imageService) => {
		const result = await buildWith(imageService);

		expect(result.service).toEqual({ entrypoint: "emdash/internal/image-service" });
		expect(result.imageSigning).toBe(true);
		expect(result.warnings.filter((w) => w.includes("signedUrls"))).toEqual([]);
	});

	// The adapter serializes no compile config under `astro dev`, whatever the mode.
	it.each([
		["the default", undefined],
		['"compile"', "compile" as const],
		[
			'{ build: "compile", runtime: "cloudflare-binding" }',
			{ build: "compile" as const, runtime: "cloudflare-binding" as const },
		],
	])("wraps the workerd service under %s in astro dev", async (_mode, imageService) => {
		const result = await buildWith(imageService, { command: "dev" });

		expect(result.service).toEqual({ entrypoint: "emdash/internal/image-service" });
		expect(result.imageSigning).toBe(true);
		expect(result.warnings.filter((w) => w.includes("signedUrls"))).toEqual([]);
	});

	it.each([
		[
			'{ build: "compile", runtime: "cloudflare-binding" }',
			{ build: "compile" as const, runtime: "cloudflare-binding" as const },
		],
		['"custom"', "custom" as const],
		['"compile"', "compile" as const],
	])("leaves the service alone and turns signing off under %s", async (_mode, imageService) => {
		const result = await buildWith(imageService);

		expect(result.service).toBeUndefined();
		expect(result.imageSigning).toBe(false);
		expect(result.warnings.some((w) => w.includes("images.signedUrls"))).toBe(true);
		expect(result.warnings.some((w) => w.includes("could not read"))).toBe(false);
	});

	it.each([
		[
			"throws",
			(plugin: VitePlugin) => {
				plugin.load = {
					handler() {
						throw new Error("changed internals");
					},
				};
			},
		],
		[
			"serializes its config differently",
			(plugin: VitePlugin) => {
				plugin.load = { handler: () => "export default {};" };
			},
		],
	])(
		"turns signing off and names the installed adapter when its config module %s",
		async (_change, alterConfigPlugin) => {
			const result = await buildWith(undefined, { alterConfigPlugin });

			expect(result.service).toBeUndefined();
			expect(result.imageSigning).toBe(false);
			expect(
				result.warnings.some(
					(w) =>
						w.includes("could not read") && w.includes(`@astrojs/cloudflare ${ADAPTER_VERSION}`),
				),
			).toBe(true);
		},
	);
});
