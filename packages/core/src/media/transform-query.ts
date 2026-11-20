/**
 * The canonical query of an image endpoint URL, shared by the image endpoint
 * helpers and image signing. Internal to core: no package entry exports it.
 */

/**
 * Query parameters of an image endpoint URL, in the order Astro's `getURL`
 * writes them. Stock-service endpoints redirect to this order without changing
 * the source `href` value.
 */
const CANONICAL_TRANSFORM_PARAMS = ["href", "w", "h", "q", "f", "fit", "position", "background"];

/**
 * The canonical query for an image endpoint request. Known parameters keep
 * their first value (the one the endpoint reads) in canonical order, followed
 * by the parameters named in the adapter's `assetQueryParams` with the
 * request's own values, then any `extraNames`; everything else is dropped.
 */
export function canonicalTransformQuery(
	url: URL,
	assetQueryParams?: URLSearchParams,
	extraNames: readonly string[] = [],
): string {
	const params = url.searchParams;
	const names = [...CANONICAL_TRANSFORM_PARAMS];
	for (const name of [...(assetQueryParams?.keys() ?? []), ...extraNames]) {
		if (!names.includes(name)) names.push(name);
	}
	const canonical = new URLSearchParams();
	for (const name of names) {
		const value = params.get(name);
		if (value !== null) canonical.append(name, value);
	}
	return canonical.toString();
}
