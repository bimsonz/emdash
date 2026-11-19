/**
 * The error a build raises when prerendered HTML would carry image transform
 * URLs without a secret to sign them (`images.signedUrls`).
 */

const BRAND = Symbol.for("emdash:image-signing-secret-required");

/**
 * Thrown while prerendering when a transform URL ships in the HTML and
 * `EMDASH_IMAGE_SECRET` is unset or blank. EmDash's image helpers re-throw it
 * rather than fall back to the original image, so the build fails instead of
 * shipping URLs the image endpoint would refuse.
 */
export class ImageSigningSecretRequiredError extends Error {
	constructor() {
		super(
			"[emdash] Prerendered pages contain image transform URLs that must be signed " +
				"(images.signedUrls). Set EMDASH_IMAGE_SECRET to the same value for the build and at runtime. " +
				"On Cloudflare the prerender reads the Worker's environment, not the build shell: " +
				"list EMDASH_IMAGE_SECRET under secrets.required in your Wrangler config and export it when you build.",
		);
		this.name = "ImageSigningSecretRequiredError";
		Object.defineProperty(this, BRAND, { value: true });
	}
}

/**
 * Recognizes the error by a registered-symbol brand rather than `instanceof`:
 * the image components compile `media/responsive.ts` from source while
 * `emdash/image-service` comes from the built package, so each holds its own
 * copy of the class.
 */
export function isImageSigningSecretRequiredError(
	error: unknown,
): error is ImageSigningSecretRequiredError {
	return typeof error === "object" && error !== null && BRAND in error;
}
