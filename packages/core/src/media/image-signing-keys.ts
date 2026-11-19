/**
 * The image signing keys, shared by the image service that signs transform
 * URLs and the image endpoints that verify them.
 */

import { readImageSigningSecretsFromEnv, resolveSecretsCached } from "../config/secrets.js";
import { getDb } from "../loader.js";
import { getRequestContext } from "../request-context.js";
import { importImageSigningKeys } from "./image-signature.js";
import { ImageSigningSecretRequiredError } from "./image-signing-error.js";

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

/**
 * The signing key for transform URLs that ship in prerendered HTML: the first
 * `EMDASH_IMAGE_SECRET` value. It never reads the database secret, because the
 * build's database holds a different generated one. Throws
 * `ImageSigningSecretRequiredError` when the variable is unset or blank, so a
 * build never ships URLs the endpoint would refuse.
 */
export async function resolveBuildImageSigningKey(): Promise<CryptoKey> {
	const secrets = readImageSigningSecretsFromEnv();
	if (!secrets) throw new ImageSigningSecretRequiredError();
	const [key] = await importImageSigningKeys(secrets.slice(0, 1));
	return key;
}
