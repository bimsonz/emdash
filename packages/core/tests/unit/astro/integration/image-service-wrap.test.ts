import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AstroIntegration } from "astro";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	detectCloudflareImageMode,
	planImageSigning,
	replacedSigningServiceWarning,
	wrapImageService,
} from "../../../../src/astro/integration/image-service-wrap.js";
import { emdash, type EmDashConfig } from "../../../../src/astro/integration/index.js";
import {
	RESOLVED_VIRTUAL_CONFIG_ID,
	RESOLVED_VIRTUAL_STOCK_IMAGE_SERVICE_ID,
} from "../../../../src/astro/integration/virtual-modules.js";

const SHARP = "astro/assets/services/sharp";
const WORKERD = "@astrojs/cloudflare/image-service-workerd";

describe("wrapImageService", () => {
	it("replaces sharp with the signing service and records sharp with its config", () => {
		const sharp = { entrypoint: SHARP, config: { kernel: "lanczos3", limitInputPixels: 1000 } };

		expect(wrapImageService(sharp)).toEqual({
			service: { entrypoint: "emdash/internal/image-service" },
			original: { entrypoint: SHARP, config: { kernel: "lanczos3", limitInputPixels: 1000 } },
		});
	});

	// @astrojs/cloudflare 14 resolves its `imageService` option (including the
	// `{ build, runtime }` form) to one Astro `image.service`, the workerd service.
	it("replaces the workerd service @astrojs/cloudflare installs", () => {
		expect(wrapImageService({ entrypoint: WORKERD, config: {} })).toEqual({
			service: { entrypoint: "emdash/internal/image-service" },
			original: { entrypoint: WORKERD, config: {} },
		});
	});

	it("records an empty config for a service set without one", () => {
		expect(wrapImageService({ entrypoint: WORKERD })).toEqual({
			service: { entrypoint: "emdash/internal/image-service" },
			original: { entrypoint: WORKERD, config: {} },
		});
	});

	it("treats an unset service as Astro's default, sharp", () => {
		expect(wrapImageService(undefined)).toEqual({
			service: { entrypoint: "emdash/internal/image-service" },
			original: { entrypoint: SHARP, config: {} },
		});
	});

	it.each([
		"./src/thumbnail-service.ts",
		"@astrojs/cloudflare/image-service",
		"emdash/internal/image-service",
	])("refuses %s with a warning", (entrypoint) => {
		const result = wrapImageService({ entrypoint, config: {} });

		expect(result).toEqual({ warn: expect.stringContaining(entrypoint) });
		expect(result).not.toHaveProperty("service");
	});

	// @astrojs/cloudflare 15 sets Astro's `image.service` to a pair: the binding
	// service transforms prerendered images at build, and the workerd service
	// builds runtime URLs. Read as one service, the pair has no entrypoint, so the
	// workerd service was recorded as sharp and the endpoint didn't treat it as stock.
	it("replaces only the runtime service of a build and runtime pair", () => {
		const build = { entrypoint: "@astrojs/cloudflare/image-service-binding" };

		expect(wrapImageService({ build, runtime: { entrypoint: WORKERD } })).toEqual({
			service: { build, runtime: { entrypoint: "emdash/internal/image-service" } },
			original: { entrypoint: WORKERD, config: {} },
		});
	});

	it("refuses a pair whose runtime service is not a stock one", () => {
		const result = wrapImageService({
			build: { entrypoint: SHARP },
			runtime: { entrypoint: "./src/thumbnail-service.ts" },
		});

		expect(result).toEqual({ warn: expect.stringContaining("./src/thumbnail-service.ts") });
	});
});

describe("replacedSigningServiceWarning", () => {
	const build = { entrypoint: "@astrojs/cloudflare/image-service-binding" };

	it("says nothing while a pair's runtime service is the signing service", () => {
		expect(
			replacedSigningServiceWarning({
				build,
				runtime: { entrypoint: "emdash/internal/image-service" },
			}),
		).toBeUndefined();
	});

	it("names the service that replaced a pair's signing runtime service", () => {
		expect(
			replacedSigningServiceWarning({ build, runtime: { entrypoint: "./src/later.ts" } }),
		).toContain("./src/later.ts");
	});
});

/**
 * The Vite plugin through which @astrojs/cloudflare 14 serializes its resolved
 * config, reduced to the export EmDash reads (`dist/vite-plugin-config.js`).
 */
function cloudflareConfigPlugin(compileImageConfig: unknown) {
	return {
		name: "virtual:astro-cloudflare:config",
		load: {
			handler() {
				return [
					`export const compileImageConfig = ${JSON.stringify(compileImageConfig)};`,
					"export const isPrerender = false;",
				].join("\n");
			},
		},
	};
}

const compileImageConfig = (transformWithBinding: boolean) => ({
	base: "/",
	imageServiceEntrypoint: WORKERD,
	buildAssets: "_astro",
	transformWithBinding,
});

/** A config plugin whose load handler is `handler`. */
function configPluginLoading(handler: () => unknown) {
	return { name: "virtual:astro-cloudflare:config", load: { handler } };
}

/** Plugin lists from which the adapter's image mode can't be read. */
const UNREADABLE: Array<[string, unknown]> = [
	["no config plugin", [{ name: "other" }]],
	["no Vite plugins", undefined],
	[
		"a load handler that throws",
		[
			configPluginLoading(() => {
				throw new Error("changed internals");
			}),
		],
	],
	["a load handler without compileImageConfig", [configPluginLoading(() => "export const x = 1;")]],
	[
		"unparseable compileImageConfig",
		[configPluginLoading(() => "export const compileImageConfig = {base: '/'};")],
	],
	[
		"a compileImageConfig without transformWithBinding",
		[
			configPluginLoading(
				() => `export const compileImageConfig = ${JSON.stringify({ base: "/" })};`,
			),
		],
	],
	["a load handler returning a non-string", [configPluginLoading(() => ({ code: "x" }))]],
];

describe("detectCloudflareImageMode", () => {
	// `astro dev` serializes `null` in every image mode, like the default modes at build.
	it("reads a null compileImageConfig as binding", () => {
		expect(detectCloudflareImageMode([cloudflareConfigPlugin(null)])).toBe("binding");
	});

	it("reads the binding build as binding", () => {
		expect(detectCloudflareImageMode([cloudflareConfigPlugin(compileImageConfig(true))])).toBe(
			"binding",
		);
	});

	it("reads the compile and custom builds as collects", () => {
		expect(detectCloudflareImageMode([[cloudflareConfigPlugin(compileImageConfig(false))]])).toBe(
			"collects",
		);
	});

	it.each(UNREADABLE)("is unknown with %s", (_case, plugins) => {
		expect(detectCloudflareImageMode(plugins)).toBe("unknown");
	});
});

describe("planImageSigning", () => {
	const workerd = { entrypoint: WORKERD, config: {} };
	let root: URL;
	let rootDir: string;

	beforeAll(() => {
		rootDir = mkdtempSync(join(tmpdir(), "emdash-plan-image-signing-"));
		const adapterDir = join(rootDir, "node_modules", "@astrojs", "cloudflare");
		mkdirSync(adapterDir, { recursive: true });
		writeFileSync(
			join(adapterDir, "package.json"),
			JSON.stringify({ name: "@astrojs/cloudflare", version: "99.1.0" }),
		);
		mkdirSync(join(rootDir, "site"));
		root = pathToFileURL(join(rootDir, "site/"));
	});

	afterAll(() => {
		rmSync(rootDir, { recursive: true, force: true });
	});

	const plan = (vitePlugins: unknown, isCloudflare = true) =>
		planImageSigning({
			endpointInstalled: true,
			isCloudflare,
			service: workerd,
			vitePlugins,
			root,
		});

	it("wraps under the Cloudflare adapter's default runtime image mode", () => {
		expect(plan([[cloudflareConfigPlugin(null)]])).toEqual({
			service: { entrypoint: "emdash/internal/image-service" },
			original: workerd,
		});
	});

	// The binding build transforms through the Images binding and never loads
	// the configured service.
	it("wraps under the binding build", () => {
		expect(plan([cloudflareConfigPlugin(compileImageConfig(true))])).toHaveProperty("original");
	});

	// `{ build: "compile" | "custom" }`: the adapter imports the configured
	// service by path in Node at build, outside Vite.
	it("refuses the compile and custom image modes with a warning", () => {
		const result = plan([[cloudflareConfigPlugin(compileImageConfig(false))]]);

		expect(result).toEqual({ warn: expect.stringContaining("compile") });
	});

	it.each(UNREADABLE)(
		"leaves signing off and names the installed adapter version with %s",
		(_case, plugins) => {
			const result = plan(plugins);

			expect(result).toEqual({ warn: expect.stringContaining("@astrojs/cloudflare 99.1.0") });
			expect(result).toEqual({ warn: expect.stringContaining("images.signedUrls") });
			expect(result).not.toHaveProperty("service");
		},
	);

	it("still warns when the adapter's version can't be found", () => {
		const result = planImageSigning({
			endpointInstalled: true,
			isCloudflare: true,
			service: workerd,
			vitePlugins: [configPluginLoading(() => "garbage")],
			root: pathToFileURL(join(tmpdir(), "emdash-no-such-project/")),
		});

		expect(result).toEqual({ warn: expect.stringContaining("@astrojs/cloudflare") });
		expect(result).not.toHaveProperty("service");
	});

	it("ignores the plugin under another adapter", () => {
		expect(plan([cloudflareConfigPlugin(compileImageConfig(false))], false)).toHaveProperty(
			"original",
		);
		expect(plan(undefined, false)).toHaveProperty("original");
	});

	it("refuses without EmDash's image endpoint", () => {
		expect(
			planImageSigning({
				endpointInstalled: false,
				isCloudflare: false,
				service: workerd,
				vitePlugins: [],
				root,
			}),
		).toEqual({ warn: expect.stringContaining("image endpoint") });
	});
});

/**
 * Runs `astro:config:setup` and returns what Astro and the runtime would
 * receive. With `finalService`, it then runs `astro:config:done` with that as
 * the `image.service` Astro ends with, as when a later integration sets one.
 */
async function setupWith(
	config: EmDashConfig,
	image: { service?: { entrypoint: string; config?: Record<string, unknown> }; endpoint?: object },
	astro: { adapter?: { name: string }; vite?: { plugins?: unknown[] } } = {},
	finalService?: { entrypoint: string; config?: Record<string, unknown> },
) {
	const integration = emdash(config);
	const setup = integration.hooks["astro:config:setup"] as NonNullable<
		AstroIntegration["hooks"]["astro:config:setup"]
	>;
	const updateConfig = vi.fn();
	const warn = vi.fn();
	const root = new URL("file:///tmp/emdash-image-service-wrap/");
	const astroConfig = {
		root,
		srcDir: new URL("src/", root),
		security: {},
		trailingSlash: "ignore",
		integrations: [{ name: "@astrojs/react", hooks: {} }],
		image,
		...astro,
	};
	const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn };
	await setup({
		command: "build",
		config: astroConfig,
		logger,
		injectRoute: vi.fn(),
		addMiddleware: vi.fn(),
		updateConfig,
	} as never);
	const update = updateConfig.mock.calls[0]?.[0] as {
		image?: { service?: unknown };
		vite?: { plugins?: Array<{ name?: string; load: (id: string) => unknown }> };
	};
	if (finalService) {
		const done = integration.hooks["astro:config:done"] as NonNullable<
			AstroIntegration["hooks"]["astro:config:done"]
		>;
		await done({
			config: { ...astroConfig, image: { ...image, service: finalService } },
			logger,
		} as never);
	}
	const virtualModules = update.vite?.plugins?.find(
		(plugin) => plugin?.name === "emdash-virtual-modules",
	);
	const configSource = String(virtualModules?.load(RESOLVED_VIRTUAL_CONFIG_ID));
	return {
		service: update.image?.service,
		runtimeConfig: JSON.parse(configSource.replace(/^export default /, "").replace(/;$/, "")) as {
			imageSigning?: boolean;
			imageRuntimeService?: unknown;
		},
		stockModule: () => String(virtualModules?.load(RESOLVED_VIRTUAL_STOCK_IMAGE_SERVICE_ID)),
		warn,
	};
}

describe("emdash() image service with images.signedUrls", () => {
	const sharp = { entrypoint: SHARP, config: { kernel: "lanczos3" } };

	it("installs the signing service and records sharp for the runtime", async () => {
		const result = await setupWith({ images: { signedUrls: true } }, { service: sharp });

		expect(result.service).toEqual({ entrypoint: "emdash/internal/image-service" });
		expect(result.runtimeConfig.imageSigning).toBe(true);
		expect(result.runtimeConfig.imageRuntimeService).toEqual(sharp);
		expect(result.stockModule()).toBe(`export { default } from "${SHARP}";`);
		expect(result.warn).not.toHaveBeenCalled();
	});

	// The spec: the site then behaves as if signing were off.
	it("leaves a custom service unsigned, turns signing off and says so", async () => {
		const result = await setupWith(
			{ images: { signedUrls: true } },
			{ service: { entrypoint: "./src/thumbnail-service.ts", config: {} } },
		);

		expect(result.service).toBeUndefined();
		expect(result.runtimeConfig.imageSigning).toBe(false);
		expect(result.runtimeConfig.imageRuntimeService).toBeUndefined();
		expect(result.warn).toHaveBeenCalledWith(expect.stringContaining("./src/thumbnail-service.ts"));
	});

	it.each([[{}], [{ images: true }], [{ images: { signedUrls: false } }]])(
		"leaves the service alone when signing is off (%j)",
		async (config) => {
			const result = await setupWith(config as EmDashConfig, { service: sharp });

			expect(result.service).toBeUndefined();
			expect(result.runtimeConfig.imageRuntimeService).toBeUndefined();
		},
	);

	// Nothing verifies a signature unless EmDash serves `/_image`.
	it("turns signing off when EmDash installs no image endpoint, and says so", async () => {
		const result = await setupWith(
			{ images: { signedUrls: true } },
			{ service: sharp, endpoint: { entrypoint: "./src/my-endpoint.ts" } },
		);

		expect(result.service).toBeUndefined();
		expect(result.runtimeConfig.imageSigning).toBe(false);
		expect(result.runtimeConfig.imageRuntimeService).toBeUndefined();
		expect(result.warn).toHaveBeenCalledWith(expect.stringContaining("images.signedUrls"));
	});

	it("turns signing off under the Cloudflare adapter's compile image mode, and says so", async () => {
		const result = await setupWith(
			{ images: { signedUrls: true } },
			{ service: { entrypoint: WORKERD, config: {} } },
			{
				adapter: { name: "@astrojs/cloudflare" },
				vite: { plugins: [[cloudflareConfigPlugin(compileImageConfig(false))]] },
			},
		);

		expect(result.service).toBeUndefined();
		expect(result.runtimeConfig.imageSigning).toBe(false);
		expect(result.runtimeConfig.imageRuntimeService).toBeUndefined();
		expect(result.warn).toHaveBeenCalledWith(expect.stringContaining("images.signedUrls"));
	});

	it("turns signing off when the Cloudflare adapter's image mode can't be read, and says so", async () => {
		const result = await setupWith(
			{ images: { signedUrls: true } },
			{ service: { entrypoint: WORKERD, config: {} } },
			{
				adapter: { name: "@astrojs/cloudflare" },
				vite: { plugins: [configPluginLoading(() => "garbage")] },
			},
		);

		expect(result.service).toBeUndefined();
		expect(result.runtimeConfig.imageSigning).toBe(false);
		expect(result.runtimeConfig.imageRuntimeService).toBeUndefined();
		expect(result.warn).toHaveBeenCalledWith(expect.stringContaining("@astrojs/cloudflare"));
	});

	it("fails the stock service module loudly when nothing was recorded", async () => {
		const result = await setupWith({}, { service: sharp });

		expect(result.stockModule()).toContain("throw new Error");
	});

	describe("when Astro's final config is done", () => {
		const signing = { images: { signedUrls: true } };
		const later = { entrypoint: "./src/later-service.ts", config: {} };

		// Its URLs carry no signature, so the endpoints would refuse every visitor image.
		it("turns signing off when a later integration replaced the signing service, and says so", async () => {
			const result = await setupWith(signing, { service: sharp }, {}, later);

			expect(result.runtimeConfig.imageSigning).toBe(false);
			expect(result.runtimeConfig.imageRuntimeService).toBeUndefined();
			expect(result.warn).toHaveBeenCalledWith(expect.stringContaining("images.signedUrls"));
			expect(result.warn).toHaveBeenCalledWith(expect.stringContaining(later.entrypoint));
		});

		it("keeps signing on while the final config uses the signing service", async () => {
			const result = await setupWith(
				signing,
				{ service: sharp },
				{},
				{
					entrypoint: "emdash/internal/image-service",
				},
			);

			expect(result.runtimeConfig.imageSigning).toBe(true);
			expect(result.runtimeConfig.imageRuntimeService).toEqual(sharp);
			expect(result.warn).not.toHaveBeenCalledWith(expect.stringContaining("images.signedUrls"));
		});

		it("says nothing about signing when it is off", async () => {
			const result = await setupWith({}, { service: sharp }, {}, later);

			expect(result.runtimeConfig.imageSigning).toBe(false);
			expect(result.warn).not.toHaveBeenCalledWith(expect.stringContaining("images.signedUrls"));
		});
	});
});
