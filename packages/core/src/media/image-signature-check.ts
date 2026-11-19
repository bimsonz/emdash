/**
 * Verification of signed image transform URLs in the image endpoints.
 *
 * Runs before any storage read or transform. A request for stored media that
 * carries no valid `_emdash_sig` is refused unless the requester is a
 * Contributor or above (who can already read every upload).
 */

import { hasPermission, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext } from "astro";

import { apiError } from "../api/error.js";
import { ErrorCode } from "../api/errors.js";
import { resolveSecretsCached } from "../config/secrets.js";
import { getDb } from "../loader.js";
import { getRequestContext } from "../request-context.js";
import { matchInternalMediaKey } from "./image-endpoint.js";
import {
	hasValidTransformSignature,
	IMAGE_SIGNATURE_PARAM,
	importImageSigningKeys,
} from "./image-signature.js";

/** The storage key of a stored-media href, for the debug log. */
function storageKeyForLog(href: string | null, publicUrl?: string): string {
	if (!href) return "(no href)";
	const internal = matchInternalMediaKey(href);
	if (internal) return internal;
	try {
		const path = new URL(href, "http://localhost").pathname;
		const base = publicUrl ? new URL(publicUrl).pathname.replace(TRAILING_SLASHES, "") : "";
		return path.toLowerCase().startsWith(`${base.toLowerCase()}/`)
			? path.slice(base.length + 1)
			: path;
	} catch {
		return href;
	}
}

const TRAILING_SLASHES = /\/+$/;

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
		const db = getRequestContext()?.db ?? (await getDb());
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- RequestContext.db is unknown to avoid circular deps
		const secrets = await resolveSecretsCached(db as Parameters<typeof resolveSecretsCached>[0]);
		keys = await importImageSigningKeys(secrets.imageSigningSecrets);
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
	console.debug(
		`[emdash] image signature ${reason}:`,
		storageKeyForLog(href, virtualConfig.imageStoragePublicUrl),
	);
	return apiError(
		ErrorCode.IMAGE_SIGNATURE_INVALID,
		"This image URL is not signed or its signature is invalid",
		403,
	);
}
