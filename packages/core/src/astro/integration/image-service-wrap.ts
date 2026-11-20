/**
 * The image service swap behind `images: { signedUrls: true }`.
 *
 * EmDash replaces the stock runtime image service with `emdash/internal/image-service`,
 * which signs the transform URLs it builds, and records the stock service so
 * the wrapper and the image endpoints can still treat it as stock.
 */

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
 * Whether the Cloudflare adapter collects static images at build through the
 * configured image service, which its `compile` and `custom` image modes do.
 * It then imports that service by path in Node, outside Vite, where
 * `emdash/internal/image-service` can't load its virtual modules (`dist/index.js`
 * `hasUserBuildImageService`, `dist/prerenderer.js`).
 *
 * `image.service` and `image.endpoint` look the same for those modes and the
 * default one, so this reads the adapter's resolved `compileImageConfig`. Its
 * setup hook runs before EmDash's and serializes it through its config Vite
 * plugin. The value is `null` without build-time image work (and in
 * `astro dev`). `transformWithBinding` marks the binding build, which
 * transforms through the Images binding and never loads the configured
 * service. When the config can't be read, the answer is `false`.
 */
export function cloudflareCollectsImagesThroughService(vitePlugins: unknown): boolean {
	const plugin = flattenPlugins(vitePlugins).find(
		(candidate) => isRecord(candidate) && candidate.name === CLOUDFLARE_CONFIG_PLUGIN,
	);
	const load = isRecord(plugin) ? plugin.load : undefined;
	const handler = isRecord(load) ? load.handler : load;
	if (typeof handler !== "function") return false;
	try {
		const source: unknown = handler.call(
			{ environment: { name: "ssr" } },
			`\0${CLOUDFLARE_CONFIG_PLUGIN}`,
		);
		const json =
			typeof source === "string" ? COMPILE_IMAGE_CONFIG_EXPORT.exec(source)?.[1] : undefined;
		if (json === undefined) return false;
		const compileImageConfig: unknown = JSON.parse(json);
		return isRecord(compileImageConfig) && compileImageConfig.transformWithBinding !== true;
	} catch {
		return false;
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
}): ReturnType<typeof wrapImageService> {
	if (!opts.endpointInstalled) {
		return {
			warn:
				"images.signedUrls needs the image endpoint EmDash installs, which this " +
				"site does not use, so image URLs are not signed.",
		};
	}
	if (opts.isCloudflare && cloudflareCollectsImagesThroughService(opts.vitePlugins)) {
		return {
			warn:
				"images.signedUrls is not supported with the Cloudflare adapter's compile or " +
				"custom image modes, so image URLs are not signed.",
		};
	}
	return wrapImageService(opts.service);
}
