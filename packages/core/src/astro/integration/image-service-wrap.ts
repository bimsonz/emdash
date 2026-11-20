/**
 * The image service swap behind `images: { signedUrls: true }`.
 *
 * EmDash replaces the stock runtime image service with `emdash/internal/image-service`,
 * which signs the transform URLs it builds, and records the stock service so
 * the wrapper and the image endpoints can still treat it as stock.
 */

import { installedPackageVersion } from "./installed-package.js";

/** The image service EmDash installs in place of a stock runtime service. */
export const SIGNING_IMAGE_SERVICE_ENTRYPOINT = "emdash/internal/image-service";

/** Astro's service when `image.service` is unset. */
const SHARP_IMAGE_SERVICE = "astro/assets/services/sharp";

/**
 * Runtime services whose URLs EmDash can sign. Both build `/_image` URLs with
 * Astro's `baseService.getURL`, whose query EmDash's endpoints canonicalize.
 */
const STOCK_RUNTIME_IMAGE_SERVICES = new Set([
	SHARP_IMAGE_SERVICE,
	"@astrojs/cloudflare/image-service-workerd",
]);

export interface RecordedImageService {
	entrypoint: string;
	config: Record<string, unknown>;
}

/**
 * Wrap Astro's `image.service` (as the adapter left it) for signing. Returns
 * the service to install and the stock service to record, or a warning for a
 * service EmDash can't sign for.
 */
export function wrapImageService(
	service: { entrypoint: string; config?: Record<string, unknown> } | undefined,
): { service: { entrypoint: string }; original: RecordedImageService } | { warn: string } {
	const entrypoint = service?.entrypoint ?? SHARP_IMAGE_SERVICE;
	if (!STOCK_RUNTIME_IMAGE_SERVICES.has(entrypoint)) {
		return {
			warn:
				`images.signedUrls applies to Astro's stock image services; the configured ` +
				`image service (${entrypoint}) is not one, so image URLs are not signed.`,
		};
	}
	return {
		service: { entrypoint: SIGNING_IMAGE_SERVICE_ENTRYPOINT },
		original: { entrypoint, config: service?.config ?? {} },
	};
}

/**
 * The warning when Astro's final `image.service` is no longer the signing
 * service EmDash installed: an integration set up after EmDash replaced it,
 * and its URLs carry no signature for the endpoints to accept.
 */
export function replacedSigningServiceWarning(
	service: { entrypoint: string } | undefined,
): string | undefined {
	if (service?.entrypoint === SIGNING_IMAGE_SERVICE_ENTRYPOINT) return undefined;
	return (
		`images.signedUrls needs the image service EmDash installs, but an integration set up ` +
		`after EmDash replaced it with ${service?.entrypoint ?? "another service"}, so image URLs ` +
		`are not signed.`
	);
}

/** The Vite plugin through which `@astrojs/cloudflare` serializes its resolved config. */
const CLOUDFLARE_CONFIG_PLUGIN = "virtual:astro-cloudflare:config";
const COMPILE_IMAGE_CONFIG_EXPORT = /^export const compileImageConfig = (.*);$/m;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function flattenPlugins(plugins: unknown): unknown[] {
	return Array.isArray(plugins) ? plugins.flatMap(flattenPlugins) : [plugins];
}

/**
 * How the Cloudflare adapter treats the configured image service at build:
 *
 * - `"collects"`: its `compile` and `custom` image modes collect static images
 *   at build through the configured service, which they import by path in
 *   Node, outside Vite, where `emdash/internal/image-service` can't load its
 *   virtual modules (`dist/index.js` `hasUserBuildImageService`,
 *   `dist/prerenderer.js`).
 * - `"binding"`: the build never loads the configured service. Either there is
 *   no build-time image work (`compileImageConfig` is `null`: the default modes,
 *   and every mode under `astro dev`, where the adapter skips build image work
 *   and the service only runs in the dev server), or the build transforms
 *   through the Images binding (`transformWithBinding`).
 * - `"unknown"`: the adapter's resolved config can't be read.
 */
export type CloudflareImageMode = "collects" | "binding" | "unknown";

/**
 * Read the Cloudflare adapter's image mode. `image.service` and
 * `image.endpoint` look the same for every mode, so this reads the adapter's
 * resolved `compileImageConfig`, which its setup hook (run before EmDash's)
 * serializes through its private `virtual:astro-cloudflare:config` Vite plugin.
 */
export function detectCloudflareImageMode(vitePlugins: unknown): CloudflareImageMode {
	const plugin = flattenPlugins(vitePlugins).find(
		(candidate) => isRecord(candidate) && candidate.name === CLOUDFLARE_CONFIG_PLUGIN,
	);
	const load = isRecord(plugin) ? plugin.load : undefined;
	const handler = isRecord(load) ? load.handler : load;
	if (typeof handler !== "function") return "unknown";
	try {
		const source: unknown = handler.call(
			{ environment: { name: "ssr" } },
			`\0${CLOUDFLARE_CONFIG_PLUGIN}`,
		);
		const json =
			typeof source === "string" ? COMPILE_IMAGE_CONFIG_EXPORT.exec(source)?.[1] : undefined;
		if (json === undefined) return "unknown";
		const compileImageConfig: unknown = JSON.parse(json);
		if (compileImageConfig === null) return "binding";
		if (!isRecord(compileImageConfig)) return "unknown";
		if (compileImageConfig.transformWithBinding === true) return "binding";
		if (compileImageConfig.transformWithBinding === false) return "collects";
		return "unknown";
	} catch {
		return "unknown";
	}
}

/**
 * Decide how `images.signedUrls` applies: the service to install and the
 * stock service to record, or a warning when signing must stay off.
 */
export function planImageSigning(opts: {
	/** EmDash installed its image endpoint, the only place signatures are checked. */
	endpointInstalled: boolean;
	isCloudflare: boolean;
	service: { entrypoint: string; config?: Record<string, unknown> } | undefined;
	vitePlugins: unknown;
	/** The project root, where the installed adapter's version is looked up. */
	root: URL;
}): ReturnType<typeof wrapImageService> {
	if (!opts.endpointInstalled) {
		return {
			warn:
				"images.signedUrls needs the image endpoint EmDash installs, which this " +
				"site does not use, so image URLs are not signed.",
		};
	}
	if (opts.isCloudflare) {
		const mode = detectCloudflareImageMode(opts.vitePlugins);
		if (mode === "collects") {
			return {
				warn:
					"images.signedUrls is not supported with the Cloudflare adapter's compile or " +
					"custom image modes, so image URLs are not signed.",
			};
		}
		if (mode === "unknown") {
			const version =
				installedPackageVersion(opts.root, "@astrojs/cloudflare") ?? "(version unknown)";
			return {
				warn:
					`images.signedUrls could not read the image mode of @astrojs/cloudflare ${version}, ` +
					"so image URLs are not signed. EmDash may not support this adapter version.",
			};
		}
	}
	return wrapImageService(opts.service);
}
