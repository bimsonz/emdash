/**
 * Image signing for the image endpoints and the image service
 * (`images.signedUrls`): the signing keys, and the check that refuses an
 * unsigned transform URL.
 *
 * Internal (`emdash/internal/image-signing`): EmDash's own image endpoints and
 * image service load it. It reads the database through `getDb()`, so the
 * portable `media/` helpers never import it.
 *
 * Callers gate on `virtual:emdash/config`'s `imageSigning` first.
 */

import { hasPermission, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";

import { apiError } from "../api/error.js";
import { ErrorCode } from "../api/errors.js";
import {
	EmDashSecretsError,
	readImageSigningSecretsFromEnv,
	resolveImageSigningSecretsCached,
} from "../config/secrets.js";
import type { Database } from "../database/types.js";
import { getDb } from "../loader.js";
import {
	hasValidTransformSignature,
	IMAGE_SIGNATURE_PARAM,
	importImageSigningKeys,
} from "../media/image-signature.js";
import { getRequestContext } from "../request-context.js";

/**
 * Imports the image signing secrets. `EMDASH_IMAGE_SECRET` wins and needs no
 * database: the request's database and `getDb()` are never touched. Otherwise
 * the secret is the one persisted in the request's database, or the configured
 * one. The first key signs; every key verifies. Throws when the variable is
 * unset and the database or the persisted secret is unavailable.
 */
export async function resolveImageSigningKeys(): Promise<CryptoKey[]> {
	const fromEnv = readImageSigningSecretsFromEnv();
	if (fromEnv) return importImageSigningKeys(fromEnv);
	const requestDb = getRequestContext()?.db ?? (await getDb());
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- RequestContext.db is unknown to avoid circular deps
	const db = requestDb as Kysely<Database>;
	return importImageSigningKeys(await resolveImageSigningSecretsCached(db));
}

/**
 * The signing key for transform URLs that ship in prerendered HTML: the first
 * `EMDASH_IMAGE_SECRET` value. It never reads the database secret, because the
 * build's database holds a different generated one. Throws an
 * `EmDashSecretsError` coded `IMAGE_SECRET_REQUIRED` when the variable is unset
 * or blank, so a build never ships URLs the endpoint would refuse.
 */
export async function resolveBuildImageSigningKey(): Promise<CryptoKey> {
	const secrets = readImageSigningSecretsFromEnv();
	if (!secrets) {
		throw new EmDashSecretsError(
			"[emdash] Prerendered pages contain image transform URLs that must be signed " +
				"(images.signedUrls). Set EMDASH_IMAGE_SECRET to the same value for the build and at runtime. " +
				"On Cloudflare the prerender reads the Worker's environment, not the build shell: " +
				"list EMDASH_IMAGE_SECRET under secrets.required in your Wrangler config and export it when you build.",
			"IMAGE_SECRET_REQUIRED",
		);
	}
	const [key] = await importImageSigningKeys(secrets.slice(0, 1));
	return key;
}

/**
 * Verification of signed image transform URLs in the image endpoints.
 *
 * Runs before any storage read, adapter handoff or transform, on every image
 * request. A request without a valid `_emdash_sig` is refused unless the
 * requester is a Contributor or above (who can already read every upload).
 *
 * Returns `null` to continue, or the `403` / `503` response to send. Neither
 * response sets cache intent.
 */
export async function checkImageSignature(ctx: APIContext, url: URL): Promise<Response | null> {
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

	if (await hasValidTransformSignature(url, keys)) return null;

	const reason = url.searchParams.has(IMAGE_SIGNATURE_PARAM) ? "invalid" : "missing";
	console.debug(
		`[emdash] image signature ${reason}:`,
		href === null ? "(no href)" : JSON.stringify(href.slice(0, 200)),
	);
	return apiError(
		ErrorCode.IMAGE_SIGNATURE_INVALID,
		"This image URL is not signed or its signature is invalid",
		403,
	);
}
