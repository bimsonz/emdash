import type { AstroIntegration } from "astro";
import { describe, expect, it, vi } from "vitest";

import {
	planImageSigning,
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

describe("planImageSigning", () => {
	const workerd = { entrypoint: WORKERD, config: {} };
	const plan = (vitePlugins: unknown, isCloudflare = true) =>
		planImageSigning({ endpointInstalled: true, isCloudflare, service: workerd, vitePlugins });

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

	it("wraps when the adapter's resolved config can't be read", () => {
		expect(plan([{ name: "other" }])).toHaveProperty("original");
		expect(plan(undefined)).toHaveProperty("original");
	});

	it("ignores the plugin under another adapter", () => {
		expect(plan([cloudflareConfigPlugin(compileImageConfig(false))], false)).toHaveProperty(
			"original",
		);
	});

	it("refuses without EmDash's image endpoint", () => {
		expect(
			planImageSigning({
				endpointInstalled: false,
				isCloudflare: false,
				service: workerd,
				vitePlugins: [],
			}),
		).toEqual({ warn: expect.stringContaining("image endpoint") });
	});
});

/** Runs `astro:config:setup` and returns what Astro and the runtime would receive. */
async function setupWith(
	config: EmDashConfig,
	image: { service?: { entrypoint: string; config?: Record<string, unknown> }; endpoint?: object },
	astro: { adapter?: { name: string }; vite?: { plugins?: unknown[] } } = {},
) {
	const setup = emdash(config).hooks["astro:config:setup"] as NonNullable<
		AstroIntegration["hooks"]["astro:config:setup"]
	>;
	const updateConfig = vi.fn();
	const warn = vi.fn();
	const root = new URL("file:///tmp/emdash-image-service-wrap/");
	await setup({
		command: "build",
		config: {
			root,
			srcDir: new URL("src/", root),
			security: {},
			trailingSlash: "ignore",
			integrations: [{ name: "@astrojs/react", hooks: {} }],
			image,
			...astro,
		},
		logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn },
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

	it("fails the stock service module loudly when nothing was recorded", async () => {
		const result = await setupWith({}, { service: sharp });

		expect(result.stockModule()).toContain("throw new Error");
	});
});
