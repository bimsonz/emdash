import type { LocalImageService } from "astro";
import { getImage, isLocalService } from "astro/assets";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = vi.hoisted(() => ({
	entrypoint: "astro/assets/services/sharp",
	config: { kernel: "lanczos3" },
}));

const { stock, getDb, resolveImageSigningSecretsCached } = vi.hoisted(() => ({
	stock: {} as Record<string, ReturnType<typeof vi.fn>>,
	getDb: vi.fn(),
	resolveImageSigningSecretsCached: vi.fn(),
}));

vi.mock("virtual:emdash/config", () => ({
	default: { imageSigning: true, imageRuntimeService: ORIGINAL },
}));
vi.mock("../../../src/loader.js", () => ({ getDb }));
vi.mock("../../../src/config/secrets.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/config/secrets.js")>()),
	resolveImageSigningSecretsCached,
}));
/**
 * Astro's `baseService.getURL` (`astro/dist/assets/services/service.js`), with
 * `BASE_URL` fixed at `/`: Astro's dist reads `import.meta.env`, which is
 * undefined in an untransformed module under vitest.
 */
function baseGetURL(
	options: { src: string | { src: string }; [key: string]: unknown },
	config: { assetQueryParams?: URLSearchParams; remotePatterns: Array<{ hostname: string }> },
): string {
	const searchParams = new URLSearchParams();
	if (typeof options.src !== "string") {
		searchParams.append("href", options.src.src);
	} else if (
		config.remotePatterns.some(
			({ hostname }) => new URL(options.src as string).hostname === hostname,
		)
	) {
		searchParams.append("href", options.src);
	} else {
		return options.src;
	}
	const params = {
		w: "width",
		h: "height",
		q: "quality",
		f: "format",
		fit: "fit",
		position: "position",
	};
	for (const [param, key] of Object.entries(params)) {
		const value = options[key];
		if (value && (typeof value === "string" || typeof value === "number")) {
			searchParams.append(param, String(value));
		}
	}
	let url = `/_image?${searchParams}`;
	const assetQueryString = config.assetQueryParams?.toString();
	if (assetQueryString) url += `&${assetQueryString}`;
	return url;
}

// The stock service is sharp itself, with every method recorded.
vi.mock("virtual:emdash/stock-image-service", async () => {
	const { default: sharp } = await import("astro/assets/services/sharp");
	Object.assign(stock, {
		validateOptions: vi.fn(sharp.validateOptions),
		getURL: vi.fn(baseGetURL),
		parseURL: vi.fn(sharp.parseURL),
		getHTMLAttributes: vi.fn(sharp.getHTMLAttributes),
		getSrcSet: vi.fn(sharp.getSrcSet),
		getRemoteSize: vi.fn(async () => ({ width: 10, height: 10, format: "png" })),
		transform: vi.fn(async () => ({ data: new Uint8Array([1]), format: "webp" })),
	});
	return { default: { ...stock, propertiesToHash: ["src", "width", "custom"] } };
});

import service from "../../../src/astro/image-service.js";
import { canonicalTransformSearch } from "../../../src/media/image-endpoint.js";
import {
	_clearImageSigningKeyCacheForTesting,
	hasValidTransformSignature,
	IMAGE_SIGNATURE_PARAM,
	importImageSigningKeys,
} from "../../../src/media/image-signature.js";
import { isImageSigningSecretRequiredError } from "../../../src/media/image-signing-error.js";
import { type EmDashRequestContext, runWithContext } from "../../../src/request-context.js";

const ORIGIN = "https://site.example";
const MEDIA = `${ORIGIN}/_emdash/api/media/file/abc.jpg`;
const REMOTE = "https://images.example.com/photo.jpg";
const BUNDLED = { src: "/_astro/photo.abc123.jpg", width: 1200, height: 800, format: "jpg" };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function imageConfig(extra: Record<string, unknown> = {}) {
	return {
		service: { entrypoint: "emdash/image-service", config: {} },
		endpoint: { route: "/_image" },
		domains: [],
		remotePatterns: [
			{ protocol: "https", hostname: "site.example" },
			{ protocol: "https", hostname: "images.example.com" },
		],
		...extra,
	};
}

/** Astro's own `getImage`, the path `<Image>` and `<Picture>` take, with the wrapper configured. */
function render(src: unknown, config = imageConfig()) {
	return getImage({ src, width: 800, height: 600, widths: [400, 800] } as never, config as never);
}

function inRequest<T>(fn: () => Promise<T>, context: Partial<EmDashRequestContext> = {}) {
	return runWithContext({ editMode: false, ...context }, fn);
}

async function verifies(path: string, secrets = ["secret-a"]): Promise<boolean> {
	return hasValidTransformSignature(new URL(path, ORIGIN), await importImageSigningKeys(secrets));
}

describe("emdash/image-service", () => {
	beforeEach(() => {
		_clearImageSigningKeyCacheForTesting();
		globalThis.astroAsset = { imageService: service } as typeof globalThis.astroAsset;
		getDb.mockResolvedValue({ singleton: true });
		resolveImageSigningSecretsCached.mockResolvedValue(["secret-a"]);
		vi.stubEnv("EMDASH_IMAGE_SECRET", undefined);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	describe("getURL", () => {
		it("signs the src and every srcset candidate Astro builds during a request", async () => {
			const image = await inRequest(() => render(MEDIA));

			const urls = [image.src, ...image.srcSet.values.map((value) => value.url)];
			expect(image.srcSet.values).toHaveLength(2);
			for (const url of urls) {
				expect(new URL(url, ORIGIN).searchParams.get("href")).toBe(MEDIA);
				expect(await verifies(url)).toBe(true);
			}
			// The 400w candidate is its own getURL call; 800w reuses the src.
			expect(stock.getURL).toHaveBeenCalledTimes(2);
		});

		it.each([
			["a bundled image", BUNDLED],
			["a remote image", REMOTE],
		])("signs %s too", async (_kind, src) => {
			const image = await inRequest(() => render(src));

			for (const url of [image.src, ...image.srcSet.values.map((value) => value.url)]) {
				expect(url).toContain(`${IMAGE_SIGNATURE_PARAM}=`);
				expect(await verifies(url)).toBe(true);
			}
		});

		it("appends the signature to the stock service's URL", async () => {
			const image = await inRequest(() => render(MEDIA));

			const stockUrl = await stock.getURL.mock.results[0]!.value;
			expect(image.src).toMatch(
				new RegExp(`^${escape(stockUrl)}&${IMAGE_SIGNATURE_PARAM}=[A-Za-z0-9_-]{22}$`),
			);
		});

		it("leaves URLs unsigned outside a request", async () => {
			const image = await render(MEDIA);

			expect(image.src).toBe(await stock.getURL.mock.results[0]!.value);
			expect(image.srcSet.attribute).not.toContain(IMAGE_SIGNATURE_PARAM);
			expect(resolveImageSigningSecretsCached).not.toHaveBeenCalled();
		});

		describe("while prerendering", () => {
			const prerendering = { prerendering: true };
			const options = { src: MEDIA, width: 800, height: 600, format: "webp" };

			it("leaves a URL Astro replaces with a generated file unsigned, without a secret", async () => {
				globalThis.astroAsset!.addStaticImage = vi.fn();

				const url = await inRequest(
					() => service.getURL(options, imageConfig() as never, logger),
					prerendering,
				);

				expect(url).toBe(await stock.getURL.mock.results[0]!.value);
				expect(url).not.toContain(IMAGE_SIGNATURE_PARAM);
				expect(resolveImageSigningSecretsCached).not.toHaveBeenCalled();
				expect(getDb).not.toHaveBeenCalled();
			});

			it("ends with Astro's static file for src and every srcset URL, reading no secret", async () => {
				// The wrapper mirrors the condition under which Astro's own getImage
				// swaps the URL for a generated file. If Astro stops swapping under it,
				// the final URLs here would be unsigned /_image URLs and this fails.
				const staticPath = "/_astro/static-abc.webp";
				const addStaticImage = vi.fn(() => staticPath);
				globalThis.astroAsset!.addStaticImage = addStaticImage;

				const image = await inRequest(() => render(MEDIA), prerendering);

				expect(image.srcSet.values).toHaveLength(2);
				expect(image.src).toBe(staticPath);
				for (const value of image.srcSet.values) expect(value.url).toBe(staticPath);
				expect(addStaticImage).toHaveBeenCalled();
				expect(resolveImageSigningSecretsCached).not.toHaveBeenCalled();
				expect(getDb).not.toHaveBeenCalled();
			});

			it("signs URLs that ship in the HTML with the first EMDASH_IMAGE_SECRET", async () => {
				vi.stubEnv("EMDASH_IMAGE_SECRET", " new , old ");

				const image = await inRequest(() => render(MEDIA), prerendering);

				const urls = [image.src, ...image.srcSet.values.map((value) => value.url)];
				expect(image.srcSet.values).toHaveLength(2);
				for (const url of urls) {
					expect(await verifies(url, ["new"])).toBe(true);
					expect(await verifies(url, ["old"])).toBe(false);
				}
				// The build's database holds a different generated secret.
				expect(resolveImageSigningSecretsCached).not.toHaveBeenCalled();
				expect(getDb).not.toHaveBeenCalled();
			});

			it.each([undefined, "", " , "])(
				"fails the build rather than ship unsigned URLs when EMDASH_IMAGE_SECRET is %j",
				async (secret) => {
					vi.stubEnv("EMDASH_IMAGE_SECRET", secret);

					const error: unknown = await inRequest(() => render(MEDIA), prerendering).then(
						() => undefined,
						(rejection: unknown) => rejection,
					);

					if (!isImageSigningSecretRequiredError(error)) {
						throw new Error(`expected the build signing error, got ${String(error)}`);
					}
					const { message } = error;
					expect(message).toContain(
						"Prerendered pages contain image transform URLs that must be signed",
					);
					expect(message).toMatch(
						/EMDASH_IMAGE_SECRET to the same value for the build and at runtime/,
					);
					expect(message).toContain("secrets.required");
					expect(message).not.toMatch(/compile/);
					expect(resolveImageSigningSecretsCached).not.toHaveBeenCalled();
				},
			);

			it("returns a source the stock service would not transform as it is, without a secret", async () => {
				const notAllowed = "https://elsewhere.example/photo.jpg";

				const image = await inRequest(() => render(notAllowed), prerendering);

				expect(image.src).toBe(notAllowed);
			});
		});

		// `astro dev` renders a prerendered route per request: the middleware
		// records prerendering=false, so the request's secret signs as usual.
		it("signs a dev render of a prerendered route with the request's secret", async () => {
			vi.stubEnv("EMDASH_IMAGE_SECRET", "env-only");

			const image = await inRequest(() => render(MEDIA), { prerendering: false });

			expect(await verifies(image.src, ["secret-a"])).toBe(true);
			expect(resolveImageSigningSecretsCached).toHaveBeenCalled();
		});

		it("returns a source the stock service would not transform as it is", async () => {
			const notAllowed = "https://elsewhere.example/photo.jpg";

			const image = await inRequest(() => render(notAllowed));

			expect(image.src).toBe(notAllowed);
			expect(image.srcSet.attribute).not.toContain(IMAGE_SIGNATURE_PARAM);
		});

		it("keeps the adapter's assetQueryParams ahead of the signature, so the endpoint needs no redirect", async () => {
			const assetQueryParams = new URLSearchParams({ dpl: "abc" });

			const image = await inRequest(() => render(MEDIA, imageConfig({ assetQueryParams })));

			for (const url of [image.src, ...image.srcSet.values.map((value) => value.url)]) {
				const parsed = new URL(url, ORIGIN);
				expect(url).toMatch(new RegExp(`&dpl=abc&${IMAGE_SIGNATURE_PARAM}=[A-Za-z0-9_-]{22}$`));
				expect(
					canonicalTransformSearch(parsed, assetQueryParams, [IMAGE_SIGNATURE_PARAM]),
				).toBeNull();
				expect(await verifies(url)).toBe(true);
			}
		});

		it("signs with the first secret", async () => {
			resolveImageSigningSecretsCached.mockResolvedValue(["new", "old"]);

			const image = await inRequest(() => render(MEDIA));

			expect(await verifies(image.src, ["new"])).toBe(true);
			expect(await verifies(image.src, ["old"])).toBe(false);
		});

		it("reads the secret through the request's database", async () => {
			const db = { scoped: true };

			await inRequest(() => render(MEDIA), { db });

			expect(resolveImageSigningSecretsCached).toHaveBeenCalledWith(db);
			expect(getDb).not.toHaveBeenCalled();
		});

		it("falls back to the configured database", async () => {
			await inRequest(() => render(MEDIA));

			expect(resolveImageSigningSecretsCached).toHaveBeenCalledWith({ singleton: true });
		});

		it("fails the render when the secret cannot be resolved", async () => {
			resolveImageSigningSecretsCached.mockRejectedValue(new Error("no database"));

			await expect(inRequest(() => render(MEDIA))).rejects.toThrow("no database");
		});
	});

	describe("delegation", () => {
		const config = imageConfig({ assetQueryParams: new URLSearchParams({ dpl: "abc" }) });
		const expected = { ...config, service: ORIGINAL };
		const options = { src: MEDIA, width: 100, height: 100, format: "webp" };

		it("stays a local image service", () => {
			expect("transform" in service).toBe(true);
			expect(isLocalService(service)).toBe(true);
		});

		it("keeps the stock propertiesToHash", () => {
			expect(service.propertiesToHash).toEqual(["src", "width", "custom"]);
		});

		it.each([
			["validateOptions", () => service.validateOptions!({ ...options }, config as never, logger)],
			["getHTMLAttributes", () => service.getHTMLAttributes!(options, config as never, logger)],
			["getSrcSet", () => service.getSrcSet!(options, config as never, logger)],
			["getRemoteSize", () => service.getRemoteSize!(REMOTE, config as never, logger)],
			[
				"parseURL",
				() => service.parseURL(new URL(`${ORIGIN}/_image?href=x`), config as never, logger),
			],
			["getURL", () => service.getURL(options, config as never, logger)],
		])("hands %s the recorded stock config", async (name, call) => {
			const result = await call();

			expect(stock[name]).toHaveBeenCalledOnce();
			expect(stock[name]!.mock.calls[0]![1]).toEqual(expected);
			expect(result).toEqual(await stock[name]!.mock.results[0]!.value);
		});

		it("hands transform the recorded stock config", async () => {
			const input = new Uint8Array([9]);
			const transform = { src: MEDIA, width: 100 };

			const result = await service.transform(input, transform, config as never, logger);

			expect(stock.transform).toHaveBeenCalledWith(input, transform, expected, logger);
			expect(result).toEqual({ data: new Uint8Array([1]), format: "webp" });
		});
	});
});

describe("emdash/image-service over a stock service without optional methods", () => {
	afterEach(() => {
		vi.doUnmock("virtual:emdash/stock-image-service");
		vi.resetModules();
	});

	it("leaves them out, so Astro falls back to its defaults", async () => {
		vi.resetModules();
		const minimal = {
			getURL: vi.fn(() => "/_image?href=x"),
			parseURL: vi.fn(),
			transform: vi.fn(),
		};
		vi.doMock("virtual:emdash/stock-image-service", () => ({ default: minimal }));

		const { default: wrapped } = (await import("../../../src/astro/image-service.js")) as {
			default: LocalImageService;
		};

		for (const name of [
			"validateOptions",
			"getHTMLAttributes",
			"getSrcSet",
			"getRemoteSize",
			"propertiesToHash",
		]) {
			expect(name in wrapped).toBe(false);
		}
		expect(typeof wrapped.getURL).toBe("function");
		expect(typeof wrapped.transform).toBe("function");
	});
});

function escape(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
