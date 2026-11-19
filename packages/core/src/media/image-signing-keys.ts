/**
 * The image signing keys, shared by the image service that signs transform
 * URLs and the image endpoints that verify them.
 */

import { resolveSecretsCached } from "../config/secrets.js";
import { getDb } from "../loader.js";
import { getRequestContext } from "../request-context.js";
import { importImageSigningKeys } from "./image-signature.js";

/**
 * Imports the image signing secrets from the request's database, or the
 * configured one. The first key signs; every key verifies. Throws when the
 * database or the secret is unavailable.
 */
export async function resolveImageSigningKeys(): Promise<CryptoKey[]> {
	const db = getRequestContext()?.db ?? (await getDb());
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- RequestContext.db is unknown to avoid circular deps
	const secrets = await resolveSecretsCached(db as Parameters<typeof resolveSecretsCached>[0]);
	return importImageSigningKeys(secrets.imageSigningSecrets);
}
