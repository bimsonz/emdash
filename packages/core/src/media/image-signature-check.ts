/**
 * Verification of signed image transform URLs in the image endpoints.
 *
 * Runs before any storage read, adapter handoff or transform, on every image
 * request. A request without a valid `_emdash_sig` is refused unless the
 * requester is a Contributor or above (who can already read every upload).
 */

import { hasPermission, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext } from "astro";

import { apiError } from "../api/error.js";
import { ErrorCode } from "../api/errors.js";
import { hasValidTransformSignature, IMAGE_SIGNATURE_PARAM } from "./image-signature.js";
import { resolveImageSigningKeys } from "./image-signing-keys.js";

/**
 * Returns `null` to continue, or the `403` / `503` response to send. Neither
 * response sets cache intent.
 */
export async function checkImageSignature(
	ctx: APIContext,
	url: URL,
	assetQueryParams?: URLSearchParams,
): Promise<Response | null> {
	// Loaded on call, not at import: this module is part of the precompiled
	// package, which plain Node imports without the virtual modules.
	// @ts-ignore - virtual module resolved by the consumer's Astro build
	const { default: virtualConfig } = await import("virtual:emdash/config");
	if (!virtualConfig?.imageSigning) return null;
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- App.Locals.user is augmented by the auth middleware, not loaded in every compilation
	const user = (ctx.locals as { user?: { role: RoleLevel } }).user;
	if (hasPermission(user, "media:upload")) return null;

	const href = url.searchParams.get("href");
	let keys: CryptoKey[];
	try {
		keys = await resolveImageSigningKeys();
	} catch {
		// Fail closed: without the secret nothing can be verified.
		return apiError(
			ErrorCode.IMAGE_SIGNING_UNAVAILABLE,
			"Image signatures cannot be verified right now",
			503,
		);
	}

	if (await hasValidTransformSignature(url, keys, assetQueryParams)) return null;

	const reason = url.searchParams.has(IMAGE_SIGNATURE_PARAM) ? "invalid" : "missing";
	console.debug(`[emdash] image signature ${reason}:`, (href ?? "(no href)").slice(0, 200));
	return apiError(
		ErrorCode.IMAGE_SIGNATURE_INVALID,
		"This image URL is not signed or its signature is invalid",
		403,
	);
}
