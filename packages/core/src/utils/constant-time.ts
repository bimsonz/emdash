/**
 * Constant-time string comparison.
 *
 * Hashes both values to fixed-length 32-byte SHA-256 digests, then XORs every
 * byte pair. The pre-hash removes length leaks. This avoids
 * `crypto.subtle.timingSafeEqual`, which is a Cloudflare Workers extension and
 * doesn't exist in Node.js.
 */
export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [hashA, hashB] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(a)),
		crypto.subtle.digest("SHA-256", encoder.encode(b)),
	]);
	const x = new Uint8Array(hashA);
	const y = new Uint8Array(hashB);
	let diff = 0;
	for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
	return diff === 0;
}
