/**
 * Helpers for the `images` option, which is `boolean | { signedUrls?: boolean }`.
 * Never test `images` by identity (`=== false`): an object is truthy and must
 * not be mistaken for `false`.
 */

type ImagesOption = boolean | { signedUrls?: boolean } | undefined;

/** Whether EmDash wraps Astro's image endpoint. Only `images: false` turns it off. */
export function imagesEnabled(images: ImagesOption): boolean {
	return images !== false;
}

/** Whether stored-media transform URLs are signed. Only `signedUrls: true` opts in. */
export function imageSigningEnabled(images: ImagesOption): boolean {
	return typeof images === "object" && images !== null && images.signedUrls === true;
}
