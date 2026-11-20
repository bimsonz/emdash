import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
	EmDashSecretsError,
	IMAGE_SECRET_OPTION_KEY,
	IP_SALT_OPTION_KEY,
	PREVIEW_SECRET_OPTION_KEY,
	_clearSecretsCacheForTesting,
	fingerprintKey,
	generateEncryptionKey,
	parseEncryptionKeys,
	primeImageSigningSecret,
	resolveImageSigningSecrets,
	resolveSecrets,
	resolveSecretsCached,
	validateEncryptionKeyAtStartup,
} from "../../../src/config/secrets.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import { markRequestScopedDb } from "../../../src/database/request-scoped.js";
import type { Database } from "../../../src/database/types.js";
import {
	createTestDatabase,
	setupTestDatabase,
	teardownTestDatabase,
} from "../../utils/test-db.js";

describe("config/secrets", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		_clearSecretsCacheForTesting();
	});

	afterEach(async () => {
		_clearSecretsCacheForTesting();
		await teardownTestDatabase(db);
	});

	describe("generateEncryptionKey", () => {
		it("emits the v1 prefix and a base64url body", () => {
			const key = generateEncryptionKey();
			expect(key.startsWith("emdash_enc_v1_")).toBe(true);
			const body = key.slice("emdash_enc_v1_".length);
			expect(body).toHaveLength(43);
			expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
		});

		it("produces unique values across calls", () => {
			const a = generateEncryptionKey();
			const b = generateEncryptionKey();
			expect(a).not.toBe(b);
		});
	});

	describe("parseEncryptionKeys", () => {
		it("returns null for unset / empty input", async () => {
			expect(await parseEncryptionKeys(undefined)).toBeNull();
			expect(await parseEncryptionKeys("")).toBeNull();
			expect(await parseEncryptionKeys(",,,")).toBeNull();
			expect(await parseEncryptionKeys("   ")).toBeNull();
		});

		it("parses a single valid key into a {kid, key, raw} entry", async () => {
			const raw = generateEncryptionKey();
			const parsed = await parseEncryptionKeys(raw);
			expect(parsed).toHaveLength(1);
			expect(parsed?.[0]?.raw).toBe(raw);
			expect(parsed?.[0]?.key).toBeInstanceOf(Uint8Array);
			expect(parsed?.[0]?.key.byteLength).toBe(32);
			expect(parsed?.[0]?.kid).toMatch(/^[0-9a-f]{8}$/);
		});

		it("kid is stable across repeated calls and matches fingerprintKey()", async () => {
			// Kid is derived from decoded key bytes (canonicality is enforced
			// upstream, so raw <-> bytes is 1:1). Repeated parses of the same
			// canonical raw string must yield the same kid, and the standalone
			// fingerprintKey() helper must agree with parseEncryptionKeys().
			const raw = generateEncryptionKey();
			const a = await parseEncryptionKeys(raw);
			const b = await parseEncryptionKeys(raw);
			expect(a?.[0]?.kid).toBe(b?.[0]?.kid);
			expect(await fingerprintKey(raw)).toBe(a?.[0]?.kid);
		});

		it("parses comma-separated multi-key with whitespace tolerance", async () => {
			const a = generateEncryptionKey();
			const b = generateEncryptionKey();
			const parsed = await parseEncryptionKeys(` ${a} ,  ${b}  ,`);
			expect(parsed).toHaveLength(2);
			expect(parsed?.[0]?.raw).toBe(a);
			expect(parsed?.[1]?.raw).toBe(b);
		});

		it("dedupes keys with the same kid (paste mistakes)", async () => {
			const raw = generateEncryptionKey();
			const parsed = await parseEncryptionKeys(`${raw},${raw}`);
			expect(parsed).toHaveLength(1);
		});

		it("throws on a malformed prefix", async () => {
			await expect(parseEncryptionKeys("not_a_key")).rejects.toBeInstanceOf(EmDashSecretsError);
		});

		it("throws on a malformed body (too short)", async () => {
			await expect(parseEncryptionKeys("emdash_enc_v1_tooShort")).rejects.toBeInstanceOf(
				EmDashSecretsError,
			);
		});

		it("throws on a malformed body (non base64url chars)", async () => {
			// 43 chars with a bad character
			const bad = "emdash_enc_v1_" + "!".repeat(43);
			await expect(parseEncryptionKeys(bad)).rejects.toBeInstanceOf(EmDashSecretsError);
		});

		it("throws if any entry in a multi-key list is malformed", async () => {
			const good = generateEncryptionKey();
			await expect(parseEncryptionKeys(`${good},not_a_key`)).rejects.toBeInstanceOf(
				EmDashSecretsError,
			);
		});

		it("rejects non-canonical base64url so kid stays stable per key material", async () => {
			// 32-byte keys encode to 43 base64url chars. The 43rd char encodes
			// 4 bits of which only the high 2 are meaningful — the low 2 bits
			// must be zero in canonical encoding. Letters whose 6-bit value
			// has zero low-2-bits: A(0), E(4), I(8), M(12), Q(16), U(20),
			// Y(24), c(28), g(32), k(36), o(40), s(44), w(48), 0(52), 4(56),
			// 8(60). Anything else in the last position encodes bits that
			// canonical encoding would set to zero — same decoded bytes,
			// different raw string. We reject these to keep kid 1:1 with
			// key material.
			//
			// "A".repeat(43) is canonical (all-zero key). Replace the last
			// char with "B" (value 1) to get a non-canonical string with
			// the same decoded bytes.
			const canonical = `emdash_enc_v1_${"A".repeat(43)}`;
			const nonCanonical = `emdash_enc_v1_${"A".repeat(42)}B`;

			// Both have the right shape so we know we're testing the
			// canonical check, not the regex.
			expect(canonical).toMatch(/^emdash_enc_v1_[A-Za-z0-9_-]{43}$/);
			expect(nonCanonical).toMatch(/^emdash_enc_v1_[A-Za-z0-9_-]{43}$/);

			// Canonical form parses fine.
			await expect(parseEncryptionKeys(canonical)).resolves.toBeTruthy();

			// Non-canonical form is rejected.
			await expect(parseEncryptionKeys(nonCanonical)).rejects.toThrow(EmDashSecretsError);
		});
	});

	describe("resolveSecrets", () => {
		it("default path generates and persists IP salt + preview secret", async () => {
			const result = await resolveSecrets({ db, env: {} });

			expect(result.ipSaltSource).toBe("db");
			expect(result.previewSecretSource).toBe("db");
			expect(result.ipSalt.length).toBeGreaterThan(0);
			expect(result.previewSecret.length).toBeGreaterThan(0);

			const repo = new OptionsRepository(db);
			expect(await repo.get<string>(IP_SALT_OPTION_KEY)).toBe(result.ipSalt);
			expect(await repo.get<string>(PREVIEW_SECRET_OPTION_KEY)).toBe(result.previewSecret);
		});

		it("does not consult EMDASH_ENCRYPTION_KEY (a malformed key cannot break preview/comments)", async () => {
			// Regression: previously a malformed EMDASH_ENCRYPTION_KEY was
			// parsed inside resolveSecrets and the throw propagated through
			// request-context middleware as a 500 to anonymous visitors with
			// stale `?_preview=` URLs. The key is validated separately at
			// startup now; resolveSecrets must not gate on it.
			const result = await resolveSecrets({
				db,
				env: { EMDASH_ENCRYPTION_KEY: "not_a_valid_key" },
			});
			expect(result.previewSecret.length).toBeGreaterThan(0);
			expect(result.ipSalt.length).toBeGreaterThan(0);
		});

		it("env override wins for preview secret and ip salt", async () => {
			const result = await resolveSecrets({
				db,
				env: {
					EMDASH_PREVIEW_SECRET: "env-preview",
					EMDASH_IP_SALT: "env-ip-salt",
				},
			});
			expect(result.previewSecret).toBe("env-preview");
			expect(result.previewSecretSource).toBe("env");
			expect(result.ipSalt).toBe("env-ip-salt");
			expect(result.ipSaltSource).toBe("env");

			// And nothing was written to the options table on the env path.
			const repo = new OptionsRepository(db);
			expect(await repo.get<string>(IP_SALT_OPTION_KEY)).toBeNull();
			expect(await repo.get<string>(PREVIEW_SECRET_OPTION_KEY)).toBeNull();
		});

		it("legacy PREVIEW_SECRET fallback works (unprefixed name)", async () => {
			const result = await resolveSecrets({
				db,
				env: { PREVIEW_SECRET: "legacy-preview" },
			});
			expect(result.previewSecret).toBe("legacy-preview");
			expect(result.previewSecretSource).toBe("env");
		});

		it("legacy EMDASH_AUTH_SECRET fallback for IP salt is honored", async () => {
			// Prior code derived the IP salt from EMDASH_AUTH_SECRET. Existing
			// installs that have only EMDASH_AUTH_SECRET set must keep the
			// same salt — otherwise their existing IP-bucket rate-limit data
			// rotates uselessly on upgrade.
			const result = await resolveSecrets({
				db,
				env: { EMDASH_AUTH_SECRET: "legacy-auth" },
			});
			expect(result.ipSalt).toBe("legacy-auth");
			expect(result.ipSaltSource).toBe("env");
		});

		it("EMDASH_IP_SALT wins over EMDASH_AUTH_SECRET fallback", async () => {
			const result = await resolveSecrets({
				db,
				env: {
					EMDASH_IP_SALT: "explicit-salt",
					EMDASH_AUTH_SECRET: "legacy-auth",
				},
			});
			expect(result.ipSalt).toBe("explicit-salt");
		});

		it("idempotent: repeated calls return the same DB-stored values", async () => {
			const a = await resolveSecrets({ db, env: {} });
			const b = await resolveSecrets({ db, env: {} });
			expect(a.ipSalt).toBe(b.ipSalt);
			expect(a.previewSecret).toBe(b.previewSecret);
		});

		it("repeated first-resolves are idempotent (sequential test of convergence)", async () => {
			// Five sequential first-resolves on a fresh DB should converge.
			// Node SQLite is synchronous, so this doesn't exercise
			// genuine cross-process concurrency. The cross-process atomicity
			// is provided by `INSERT ... ON CONFLICT DO NOTHING` at the DB
			// layer; see the lost-race test below for in-process coverage
			// of the re-read path.
			const promises: Promise<Awaited<ReturnType<typeof resolveSecrets>>>[] = [];
			for (let i = 0; i < 5; i++) {
				promises.push(resolveSecrets({ db, env: {} }));
			}
			const results = await Promise.all(promises);
			const ipSalts = new Set(results.map((r) => r.ipSalt));
			const previews = new Set(results.map((r) => r.previewSecret));
			expect(ipSalts.size).toBe(1);
			expect(previews.size).toBe(1);
		});

		it("returns the existing row when first-read finds one already populated", async () => {
			// Pre-populate the row, then resolve. Exercises the early-return
			// branch in `ensureGeneratedOption` where the first read hits.
			const winnerSalt = "row-already-populated";
			const repo = new OptionsRepository(db);
			await repo.set(IP_SALT_OPTION_KEY, winnerSalt);

			const result = await resolveSecrets({ db, env: {} });
			expect(result.ipSalt).toBe(winnerSalt);
			expect(result.ipSaltSource).toBe("db");
		});

		it("converges via lost-race re-read when setIfAbsent reports no insert", async () => {
			// Simulate a genuine cross-process race: caller A reads (no row),
			// caller B inserts the winner, caller A's setIfAbsent loses
			// (returns false). A then re-reads and converges on B's value.
			//
			// We stub `setIfAbsent` to inject the "concurrent process won"
			// behavior on the IP-salt key specifically (the resolver also
			// does this for preview secret in parallel; we need to target
			// one to assert).
			const winnerSalt = "concurrent-process-won";
			const realRepo = new OptionsRepository(db);
			const stubRepo = Object.create(realRepo) as OptionsRepository;
			stubRepo.setIfAbsent = async <T>(name: string, value: T) => {
				if (name === IP_SALT_OPTION_KEY) {
					// Simulate "winner" inserting first; tell our caller the
					// insert didn't take so it falls through to the re-read.
					await realRepo.set(name, winnerSalt);
					return false;
				}
				return realRepo.setIfAbsent(name, value);
			};

			const result = await resolveSecrets({ db, env: {}, _repo: stubRepo });
			expect(result.ipSalt).toBe(winnerSalt);
			expect(result.ipSaltSource).toBe("db");
		});

		it("throws SECRET_PERSIST_FAILED when setIfAbsent loses but the row is empty after re-read", async () => {
			// Pathological case: setIfAbsent says "didn't insert" but the
			// row is still missing. This shouldn't happen in practice with
			// a sane DB, but the resolver guards against it rather than
			// looping forever or returning an empty string.
			const realRepo = new OptionsRepository(db);
			const stubRepo = Object.create(realRepo) as OptionsRepository;
			stubRepo.setIfAbsent = async () => false; // Always claim no-op, no row appears.

			await expect(resolveSecrets({ db, env: {}, _repo: stubRepo })).rejects.toThrow(
				/SECRET_PERSIST_FAILED|Failed to persist/,
			);
		});

		it("reads the default env from process.env when no env map is passed", async () => {
			// Regression test for #2139: secrets must come from the runtime
			// process env, never from build-time `import.meta.env`
			// substitution (which would embed the secret in the server
			// bundle and shadow the platform-configured value).
			const previous = process.env.EMDASH_PREVIEW_SECRET;
			process.env.EMDASH_PREVIEW_SECRET = "proc-preview-secret";
			try {
				const result = await resolveSecrets({ db });
				expect(result.previewSecret).toBe("proc-preview-secret");
				expect(result.previewSecretSource).toBe("env");
			} finally {
				if (previous === undefined) {
					delete process.env.EMDASH_PREVIEW_SECRET;
				} else {
					process.env.EMDASH_PREVIEW_SECRET = previous;
				}
			}
		});
	});

	describe("image signing secret", () => {
		const unreachable = () => {
			throw new Error("getDb must not be called");
		};

		it("resolveSecrets alone creates no emdash:image_secret row", async () => {
			const result = await resolveSecrets({ db, env: {} });
			expect(result).not.toHaveProperty("imageSigningSecrets");
			expect(await new OptionsRepository(db).get(IMAGE_SECRET_OPTION_KEY)).toBeNull();
			expect(await new OptionsRepository(db).get(PREVIEW_SECRET_OPTION_KEY)).not.toBeNull();
		});

		it("resolveSecretsCached alone creates no emdash:image_secret row", async () => {
			await resolveSecretsCached(db);
			expect(await new OptionsRepository(db).get(IMAGE_SECRET_OPTION_KEY)).toBeNull();
		});

		it('returns EMDASH_IMAGE_SECRET " new , old ,," as ["new","old"] without opening the database', async () => {
			const getDb = vi.fn(unreachable);
			const result = await resolveImageSigningSecrets({
				getDb,
				env: { EMDASH_IMAGE_SECRET: " new , old ,," },
			});
			expect(result).toEqual({ secrets: ["new", "old"], source: "env" });
			expect(getDb).not.toHaveBeenCalled();
			expect(await new OptionsRepository(db).get(IMAGE_SECRET_OPTION_KEY)).toBeNull();
		});

		it("treats an all-blank EMDASH_IMAGE_SECRET as unset", async () => {
			const result = await resolveImageSigningSecrets({
				getDb: () => db,
				env: { EMDASH_IMAGE_SECRET: " , ,  " },
			});
			expect(result).toEqual({
				secrets: [await new OptionsRepository(db).get<string>(IMAGE_SECRET_OPTION_KEY)],
				source: "db",
			});
		});

		it("without the env var, opens the database once, generates once and persists under emdash:image_secret", async () => {
			const getDb = vi.fn(async () => db);
			const first = await resolveImageSigningSecrets({ getDb, env: {} });
			const second = await resolveImageSigningSecrets({ getDb, env: {} });
			expect(first.source).toBe("db");
			expect(first.secrets).toHaveLength(1);
			expect(first.secrets[0]!.length).toBeGreaterThan(0);
			expect(second).toEqual(first);
			expect(getDb).toHaveBeenCalledTimes(1);
			expect(await new OptionsRepository(db).get<string>(IMAGE_SECRET_OPTION_KEY)).toBe(
				first.secrets[0],
			);
		});

		it("returns the stored emdash:image_secret", async () => {
			await new OptionsRepository(db).set(IMAGE_SECRET_OPTION_KEY, "stored-secret");
			expect(await resolveImageSigningSecrets({ getDb: () => db, env: {} })).toEqual({
				secrets: ["stored-secret"],
				source: "db",
			});
		});

		it("coalesces concurrent cold resolutions in one isolate onto one database read", async () => {
			const getDb = vi.fn(async () => db);
			const [a, b] = await Promise.all([
				resolveImageSigningSecrets({ getDb, env: {} }),
				resolveImageSigningSecrets({ getDb, env: {} }),
			]);
			expect(a).toEqual(b);
			expect(getDb).toHaveBeenCalledTimes(1);
		});

		it("two isolates resolving concurrently converge on one persisted value", async () => {
			// Each isolate has its own cache. Clearing it between the two calls gives
			// the second call a fresh one, so both race to generate and persist.
			const first = resolveImageSigningSecrets({ getDb: async () => db, env: {} });
			_clearSecretsCacheForTesting();
			const second = resolveImageSigningSecrets({ getDb: async () => db, env: {} });
			const [a, b] = await Promise.all([first, second]);
			expect(a).toEqual(b);
			expect(await new OptionsRepository(db).get<string>(IMAGE_SECRET_OPTION_KEY)).toBe(
				a.secrets[0],
			);
		});

		it("converges on the value another isolate persisted first", async () => {
			const winner = "other-isolate-won";
			const realRepo = new OptionsRepository(db);
			const stubRepo = Object.create(realRepo) as OptionsRepository;
			stubRepo.setIfAbsent = async <T>(name: string, value: T) => {
				if (name === IMAGE_SECRET_OPTION_KEY) {
					await realRepo.set(name, winner);
					return false;
				}
				return realRepo.setIfAbsent(name, value);
			};

			const result = await resolveImageSigningSecrets({
				getDb: () => db,
				env: {},
				_repo: stubRepo,
			});
			expect(result).toEqual({ secrets: [winner], source: "db" });
		});

		it("throws SECRET_PERSIST_FAILED when the insert loses but no row appears", async () => {
			const stubRepo = Object.create(new OptionsRepository(db)) as OptionsRepository;
			stubRepo.setIfAbsent = async () => false;

			await expect(
				resolveImageSigningSecrets({ getDb: () => db, env: {}, _repo: stubRepo }),
			).rejects.toThrow(/Failed to persist/);
		});

		it("is distinct from the preview secret", async () => {
			const { secrets } = await resolveImageSigningSecrets({ getDb: () => db, env: {} });
			const { previewSecret } = await resolveSecrets({ db, env: {} });
			expect(secrets[0]).not.toBe(previewSecret);
			const repo = new OptionsRepository(db);
			expect(await repo.get(PREVIEW_SECRET_OPTION_KEY)).not.toBe(
				await repo.get(IMAGE_SECRET_OPTION_KEY),
			);
		});

		it("reads EMDASH_IMAGE_SECRET from process.env when no env is passed", async () => {
			const previous = process.env.EMDASH_IMAGE_SECRET;
			process.env.EMDASH_IMAGE_SECRET = "k1,k0";
			try {
				expect(await resolveImageSigningSecrets({ getDb: unreachable })).toEqual({
					secrets: ["k1", "k0"],
					source: "env",
				});
			} finally {
				if (previous === undefined) delete process.env.EMDASH_IMAGE_SECRET;
				else process.env.EMDASH_IMAGE_SECRET = previous;
			}
		});

		it("memoizes the database secret until the cache is cleared", async () => {
			const a = await resolveImageSigningSecrets({ getDb: () => db, env: {} });
			const b = await resolveImageSigningSecrets({ getDb: () => db, env: {} });
			expect(b.secrets).toBe(a.secrets);
			_clearSecretsCacheForTesting();
			const c = await resolveImageSigningSecrets({ getDb: () => db, env: {} });
			expect(c.secrets).not.toBe(a.secrets);
			expect(c.secrets).toEqual(a.secrets);
		});

		it("serves a request-scoped view of the configured database from the configured resolution", async () => {
			const first = await resolveImageSigningSecrets({ getDb: () => db, env: {} });
			// Unmigrated, so any query through it would throw.
			const view = createTestDatabase();
			markRequestScopedDb(view);
			try {
				expect(
					await resolveImageSigningSecrets({ requestDb: view, getDb: unreachable, env: {} }),
				).toEqual(first);
			} finally {
				await view.destroy();
			}
		});

		it("does not open the configured database for a request database", async () => {
			const getDb = vi.fn(unreachable);
			const result = await resolveImageSigningSecrets({ requestDb: db, getDb, env: {} });
			expect(result.secrets).toEqual([
				await new OptionsRepository(db).get<string>(IMAGE_SECRET_OPTION_KEY),
			]);
			expect(getDb).not.toHaveBeenCalled();
		});

		// The Durable Object preview sets its database without `dbIsIsolated`.
		it("keeps another database's secret apart from the configured database's, either order", async () => {
			const other = await setupTestDatabase();
			try {
				await new OptionsRepository(db).set(IMAGE_SECRET_OPTION_KEY, "configured");
				await new OptionsRepository(other).set(IMAGE_SECRET_OPTION_KEY, "other");

				expect(
					await resolveImageSigningSecrets({ requestDb: other, getDb: unreachable, env: {} }),
				).toEqual({ secrets: ["other"], source: "db" });
				expect(await resolveImageSigningSecrets({ getDb: () => db, env: {} })).toEqual({
					secrets: ["configured"],
					source: "db",
				});

				_clearSecretsCacheForTesting();
				expect(await resolveImageSigningSecrets({ getDb: () => db, env: {} })).toEqual({
					secrets: ["configured"],
					source: "db",
				});
				expect(
					await resolveImageSigningSecrets({ requestDb: other, getDb: unreachable, env: {} }),
				).toEqual({ secrets: ["other"], source: "db" });
			} finally {
				await teardownTestDatabase(other);
			}
		});

		describe("primeImageSigningSecret", () => {
			it("serves the value runtime init read without opening the database", async () => {
				await primeImageSigningSecret(db, "read-at-init");
				const getDb = vi.fn(unreachable);
				expect(await resolveImageSigningSecrets({ getDb, env: {} })).toEqual({
					secrets: ["read-at-init"],
					source: "db",
				});
				expect(getDb).not.toHaveBeenCalled();
			});

			it("persists a generated secret when the row is missing, then serves it", async () => {
				await primeImageSigningSecret(db, undefined);
				const stored = await new OptionsRepository(db).get<string>(IMAGE_SECRET_OPTION_KEY);
				expect(stored).toEqual(expect.any(String));
				expect(await resolveImageSigningSecrets({ getDb: unreachable, env: {} })).toEqual({
					secrets: [stored],
					source: "db",
				});
			});

			it("converges on a row another isolate created after init read it as missing", async () => {
				await new OptionsRepository(db).set(IMAGE_SECRET_OPTION_KEY, "created-meanwhile");
				await primeImageSigningSecret(db, undefined);
				expect(await resolveImageSigningSecrets({ getDb: unreachable, env: {} })).toEqual({
					secrets: ["created-meanwhile"],
					source: "db",
				});
			});

			it("keeps a secret already resolved on the isolate", async () => {
				await new OptionsRepository(db).set(IMAGE_SECRET_OPTION_KEY, "resolved-first");
				await resolveImageSigningSecrets({ getDb: () => db, env: {} });
				await primeImageSigningSecret(db, "stale");
				expect(await resolveImageSigningSecrets({ getDb: unreachable, env: {} })).toEqual({
					secrets: ["resolved-first"],
					source: "db",
				});
			});
		});
	});

	describe("validateEncryptionKeyAtStartup", () => {
		it("returns true for an unset key", async () => {
			expect(await validateEncryptionKeyAtStartup({})).toBe(true);
		});

		it("returns true for a valid key", async () => {
			const key = generateEncryptionKey();
			expect(await validateEncryptionKeyAtStartup({ EMDASH_ENCRYPTION_KEY: key })).toBe(true);
		});

		it("returns false (and does not throw) for a malformed key, logging an operator-facing message", async () => {
			const errors: unknown[][] = [];
			const original = console.error;
			console.error = (...args: unknown[]) => {
				errors.push(args);
			};
			try {
				const result = await validateEncryptionKeyAtStartup({
					EMDASH_ENCRYPTION_KEY: "not_a_valid_key",
				});
				expect(result).toBe(false);
				expect(errors).toHaveLength(1);
				expect(String(errors[0]?.[0])).toMatch(/EMDASH_ENCRYPTION_KEY is invalid/);
			} finally {
				console.error = original;
			}
		});
	});

	describe("fingerprintKey", () => {
		it("agrees with parseEncryptionKeys on canonical input", async () => {
			const raw = generateEncryptionKey();
			const parsed = await parseEncryptionKeys(raw);
			expect(await fingerprintKey(raw)).toBe(parsed?.[0]?.kid);
		});

		it("rejects non-canonical base64url (so the CLI can't print kids the runtime would refuse)", async () => {
			const nonCanonical = `emdash_enc_v1_${"A".repeat(42)}B`;
			await expect(fingerprintKey(nonCanonical)).rejects.toBeInstanceOf(EmDashSecretsError);
		});

		it("rejects a malformed prefix", async () => {
			await expect(fingerprintKey("not_a_key")).rejects.toBeInstanceOf(EmDashSecretsError);
		});

		it("rejects bodies of the wrong length", async () => {
			await expect(fingerprintKey("emdash_enc_v1_tooShort")).rejects.toBeInstanceOf(
				EmDashSecretsError,
			);
		});
	});

	describe("resolveSecretsCached", () => {
		it("memoizes per-db so multiple callers share one resolved value", async () => {
			// First caller starts the resolution; second caller piggybacks.
			// We can verify they share a value (and the cache key is the db
			// instance) by comparing against a freshly cleared cache.
			const a = await resolveSecretsCached(db);
			const b = await resolveSecretsCached(db);
			expect(a).toBe(b);

			_clearSecretsCacheForTesting();
			const c = await resolveSecretsCached(db);
			// Different cache entry, but same persisted DB values.
			expect(c).not.toBe(a);
			expect(c.ipSalt).toBe(a.ipSalt);
			expect(c.previewSecret).toBe(a.previewSecret);
		});
	});

	describe("source hygiene", () => {
		it("never references import.meta.env in code (would be inlined into the server bundle at build time)", async () => {
			// Regression guard for #2139. Vite statically replaces the bare
			// `import.meta.env` expression with an object literal built from
			// the build-time env, embedding secrets from `.env` into
			// `dist/server` and shadowing platform-configured runtime values.
			const source = await readFile(
				fileURLToPath(new URL("../../../src/config/secrets.ts", import.meta.url)),
				"utf8",
			);
			const withoutComments = source
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/^[ \t]*\/\/.*$/gm, "");
			expect(withoutComments).not.toContain("import.meta.env");
		});
	});
});
