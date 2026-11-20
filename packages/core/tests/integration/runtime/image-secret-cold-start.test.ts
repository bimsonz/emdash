/**
 * EmDashRuntime.create() and the image signing secret (`images.signedUrls`).
 *
 * Runtime init reads `emdash:image_secret` with the other site options and
 * seeds the image-secret cache, so the first signed render on an isolate runs
 * no query of its own for it.
 */

import { randomUUID } from "node:crypto";

import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import {
	_clearSecretsCacheForTesting,
	IMAGE_SECRET_OPTION_KEY,
	resolveImageSigningSecrets,
} from "../../../src/config/secrets.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import { markRequestScopedDb } from "../../../src/database/request-scoped.js";
import type { Database as EmDashDatabase } from "../../../src/database/types.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import type { RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { runWithContext } from "../../../src/request-context.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const virtualConfig = vi.hoisted(() => ({ imageSigning: false }));
vi.mock("virtual:emdash/config", () => ({ default: virtualConfig }));

/** Dependencies over one SQLite database that outlives each runtime. */
function createDeps(sqlite: InstanceType<typeof Database>): RuntimeDependencies {
	return {
		config: {
			database: {
				// A fresh entrypoint per runtime so the module-level db cache never
				// hands one runtime another's instance.
				entrypoint: `test-image-secret-${randomUUID()}`,
				config: {},
				type: "sqlite",
			},
		},
		plugins: [],
		createDialect: () => new SqliteDialect({ database: sqlite }),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};
}

const noQuery = () => {
	throw new Error("the image secret should not need a query");
};

async function storedSecret(sqlite: InstanceType<typeof Database>): Promise<unknown> {
	const db = new Kysely<EmDashDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
	return new OptionsRepository(db).get(IMAGE_SECRET_OPTION_KEY);
}

describe("EmDashRuntime.create — image signing secret", () => {
	let sqlite: InstanceType<typeof Database>;

	beforeEach(() => {
		sqlite = new Database(":memory:");
		virtualConfig.imageSigning = true;
		vi.stubEnv("EMDASH_IMAGE_SECRET", "");
		_clearSecretsCacheForTesting();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		_clearSecretsCacheForTesting();
		virtualConfig.imageSigning = false;
	});

	it("creates the secret on a site's first request and serves it without a query", async () => {
		const runtime = await EmDashRuntime.create(createDeps(sqlite));
		try {
			const stored = await storedSecret(sqlite);
			expect(stored).toEqual(expect.any(String));
			expect(await resolveImageSigningSecrets({ getDb: noQuery })).toEqual({
				secrets: [stored],
				source: "db",
			});
		} finally {
			await runtime.shutdown();
		}
	});

	it("serves a stored secret read with the site options", async () => {
		const first = await EmDashRuntime.create(createDeps(sqlite));
		await first.shutdown();
		const stored = await storedSecret(sqlite);
		// A new isolate: nothing resolved yet.
		_clearSecretsCacheForTesting();

		const runtime = await EmDashRuntime.create(createDeps(sqlite));
		try {
			expect(await resolveImageSigningSecrets({ getDb: noQuery })).toEqual({
				secrets: [stored],
				source: "db",
			});
			expect(await storedSecret(sqlite)).toBe(stored);
		} finally {
			await runtime.shutdown();
		}
	});

	it("neither creates nor caches the secret with signing off", async () => {
		virtualConfig.imageSigning = false;
		const runtime = await EmDashRuntime.create(createDeps(sqlite));
		try {
			expect(await storedSecret(sqlite)).toBeNull();
			await expect(resolveImageSigningSecrets({ getDb: noQuery })).rejects.toThrow(
				"should not need a query",
			);
		} finally {
			await runtime.shutdown();
		}
	});

	it("creates no secret row when EMDASH_IMAGE_SECRET is set", async () => {
		vi.stubEnv("EMDASH_IMAGE_SECRET", "from-env");
		const runtime = await EmDashRuntime.create(createDeps(sqlite));
		try {
			expect(await storedSecret(sqlite)).toBeNull();
			expect(await resolveImageSigningSecrets({ getDb: noQuery })).toEqual({
				secrets: ["from-env"],
				source: "env",
			});
		} finally {
			await runtime.shutdown();
		}
	});

	describe("the site options read", () => {
		/** The keys of the runtime's site options read, the `getMany` that asks for `site:title`. */
		async function siteOptionKeys(create: () => Promise<EmDashRuntime>): Promise<string[]> {
			const getMany = vi.spyOn(OptionsRepository.prototype, "getMany");
			try {
				const runtime = await create();
				await runtime.shutdown();
				const reads = getMany.mock.calls
					.map(([keys]) => keys)
					.filter((keys) => keys.includes("site:title"));
				expect(reads.length).toBeGreaterThan(0);
				return reads.flat();
			} finally {
				getMany.mockRestore();
			}
		}

		it("asks for emdash:image_secret with signing on, no EMDASH_IMAGE_SECRET and the configured database", async () => {
			const keys = await siteOptionKeys(() => EmDashRuntime.create(createDeps(sqlite)));
			expect(keys).toContain(IMAGE_SECRET_OPTION_KEY);
		});

		it("leaves emdash:image_secret out with signing off", async () => {
			virtualConfig.imageSigning = false;
			const keys = await siteOptionKeys(() => EmDashRuntime.create(createDeps(sqlite)));
			expect(keys).not.toContain(IMAGE_SECRET_OPTION_KEY);
		});

		it("leaves emdash:image_secret out when EMDASH_IMAGE_SECRET is set", async () => {
			vi.stubEnv("EMDASH_IMAGE_SECRET", "from-env");
			const keys = await siteOptionKeys(() => EmDashRuntime.create(createDeps(sqlite)));
			expect(keys).not.toContain(IMAGE_SECRET_OPTION_KEY);
		});

		it("leaves emdash:image_secret out for a runtime on an isolated database", async () => {
			const isolated = await setupTestDatabase();
			try {
				const keys = await siteOptionKeys(() =>
					runWithContext({ editMode: false, db: isolated, dbIsIsolated: true }, () =>
						EmDashRuntime.create(createDeps(sqlite)),
					),
				);
				expect(keys).not.toContain(IMAGE_SECRET_OPTION_KEY);
			} finally {
				await teardownTestDatabase(isolated);
			}
		});

		// The Durable Object preview sets its database without `dbIsIsolated`.
		it("leaves emdash:image_secret out and primes nothing inside another database's request", async () => {
			const previewDb = await setupTestDatabase();
			try {
				const keys = await siteOptionKeys(() =>
					runWithContext({ editMode: false, db: previewDb }, () =>
						EmDashRuntime.create(createDeps(sqlite)),
					),
				);
				expect(keys).not.toContain(IMAGE_SECRET_OPTION_KEY);
				await expect(resolveImageSigningSecrets({ getDb: noQuery })).rejects.toThrow(
					"should not need a query",
				);
				expect(await new OptionsRepository(previewDb).get(IMAGE_SECRET_OPTION_KEY)).toBeNull();
			} finally {
				await teardownTestDatabase(previewDb);
			}
		});

		it("asks for emdash:image_secret inside a request on a request-scoped view of the configured database", async () => {
			const view = new Kysely<EmDashDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
			markRequestScopedDb(view);
			const keys = await siteOptionKeys(() =>
				runWithContext({ editMode: false, db: view }, () =>
					EmDashRuntime.create(createDeps(sqlite)),
				),
			);
			expect(keys).toContain(IMAGE_SECRET_OPTION_KEY);
			expect(await resolveImageSigningSecrets({ getDb: noQuery })).toEqual({
				secrets: [await storedSecret(sqlite)],
				source: "db",
			});
		});
	});
});
