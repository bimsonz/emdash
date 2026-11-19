/**
 * The image service swap behind `images: { signedUrls: true }`.
 *
 * EmDash replaces the stock runtime image service with `emdash/image-service`,
 * which signs the transform URLs it builds, and records the stock service so
 * the wrapper and the image endpoints can still treat it as stock.
 */

/** The image service EmDash installs in place of a stock runtime service. */
export const SIGNING_IMAGE_SERVICE_ENTRYPOINT = "emdash/image-service";

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
): { service: { entrypoint: string }; original: RecordedImageService } | { warning: string } {
	const entrypoint = service?.entrypoint ?? SHARP_IMAGE_SERVICE;
	if (!STOCK_RUNTIME_IMAGE_SERVICES.has(entrypoint)) {
		return {
			warning:
				`images.signedUrls applies to Astro's stock image services; the configured ` +
				`image service (${entrypoint}) is not one, so image URLs are not signed.`,
		};
	}
	return {
		service: { entrypoint: SIGNING_IMAGE_SERVICE_ENTRYPOINT },
		original: { entrypoint, config: service?.config ?? {} },
	};
}
