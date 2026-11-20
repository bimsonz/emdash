/**
 * Signed image transform URLs.
 *
 * The signature is `HMAC-SHA256(secret, "emdash-image-v1\n" + canonicalQuery)`
 * truncated to 128 bits and encoded as unpadded base64url (22 characters).
 * `canonicalQuery` excludes the adapter's `assetQueryParams` and the signature
 * itself, so a reordered or re-encoded query verifies.
 */

import { encodeBase64url } from "../utils/base64.js";
import { timingSafeEqualString } from "../utils/constant-time.js";
import { canonicalTransformQuery, IMAGE_SIGNATURE_PARAM } from "./image-endpoint.js";

export { IMAGE_SIGNATURE_PARAM };

const DOMAIN_PREFIX = "emdash-image-v1\n";
const SIGNATURE_BYTES = 16;

// On globalThis under a registered symbol: two copies of this module (the
// built package and a source compile) must share one cache. Versioned so a
// shape change doesn't collide with an older co-resident build.
const KEY_CACHE = Symbol.for("@emdash-cms/core/image-key-cache@1");

function getKeyCache(): Map<string, Promise<CryptoKey>> {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern
	const holder = globalThis as Record<symbol, Map<string, Promise<CryptoKey>> | undefined>;
	return (holder[KEY_CACHE] ??= new Map());
}

/** Import HMAC keys for the given secrets. Cached per isolate by secret string. */
export function importImageSigningKeys(secrets: readonly string[]): Promise<CryptoKey[]> {
	const keyCache = getKeyCache();
	return Promise.all(
		secrets.map((secret) => {
			let key = keyCache.get(secret);
			if (!key) {
				key = crypto.subtle.importKey(
					"raw",
					new TextEncoder().encode(secret),
					{ name: "HMAC", hash: "SHA-256" },
					false,
					["sign"],
				);
				keyCache.set(secret, key);
				// Don't cache a failed import.
				key.catch(() => keyCache.delete(secret));
			}
			return key;
		}),
	);
}

/** Clear the imported key cache. Test use only. */
export function _clearImageSigningKeyCacheForTesting(): void {
	getKeyCache().clear();
}

async function computeSignature(canonicalQuery: string, key: CryptoKey): Promise<string> {
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(DOMAIN_PREFIX + canonicalQuery),
	);
	return encodeBase64url(new Uint8Array(mac).slice(0, SIGNATURE_BYTES));
}

/**
 * Sign an image endpoint URL. Returns the path and query with `_emdash_sig`
 * after the canonical parameters and any `assetQueryParams`.
 */
export async function signTransformUrl(
	url: URL,
	signingKey: CryptoKey,
	assetQueryParams?: URLSearchParams,
): Promise<string> {
	const canonical = canonicalTransformQuery(url, undefined, []);
	const sig = await computeSignature(canonical, signingKey);
	const asset = assetQueryParams?.toString();
	return `${url.pathname}?${canonical}${asset ? `&${asset}` : ""}&${IMAGE_SIGNATURE_PARAM}=${sig}`;
}

/** True when the request carries exactly one `_emdash_sig` that any key accepts. */
export async function hasValidTransformSignature(
	url: URL,
	verifyingKeys: readonly CryptoKey[],
): Promise<boolean> {
	const sigs = url.searchParams.getAll(IMAGE_SIGNATURE_PARAM);
	if (sigs.length !== 1) return false;
	const provided = sigs[0];
	if (provided.length === 0) return false;
	const canonical = canonicalTransformQuery(url, undefined, []);
	let valid = false;
	for (const key of verifyingKeys) {
		const expected = await computeSignature(canonical, key);
		if (await timingSafeEqualString(provided, expected)) valid = true;
	}
	return valid;
}
