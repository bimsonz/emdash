/**
 * Signed image URLs from render to the Node image endpoint: what the signing
 * image service renders over Astro's sharp service is served as rendered, with
 * no redirect, and reaches the stock endpoint unaltered.
 */

import type { APIContext } from "astro";
import { getImage } from "astro/assets";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { imageConfig, transform } = vi.hoisted(() => ({
	imageConfig: {
		service: { entrypoint: "emdash/internal/image-service", config: {} },
		endpoint: { route: "/_image" },
		domains: [] as string[],
		remotePatterns: [
			{ protocol: "https", hostname: "site.example" },
			{ protocol: "https", hostname: "images.example.com" },
		],
		assetQueryParams: new URLSearchParams({ dpl: "abc" }),
	},
	transform: vi.fn(async () => ({ data: new Uint8Array([4, 5, 6]), format: "webp" })),
}));

vi.mock("virtual:emdash/config", () => ({
	default: {
		imageSigning: true,
		imageRuntimeService: { entrypoint: "astro/assets/services/sharp", config: {} },
	},
}));
vi.mock("virtual:emdash/stock-image-service", async () => {
	const { default: sharp } = await import("astro/assets/services/sharp");
	return { default: { ...sharp, transform } };
});
vi.mock("astro:assets", () => ({
	getConfiguredImageService: async () =>
		(await import("../../../src/astro/image-service.js")).default,
	imageConfig,
}));
vi.mock("astro/assets/endpoint/generic", () => ({
	GET: vi.fn(async () => new Response("stock", { status: 200 })),
}));

import { GET as genericGET } from "astro/assets/endpoint/generic";

import { GET } from "../../../src/astro/image-endpoint.js";
import service from "../../../src/astro/image-service.js";
import { _clearSecretsCacheForTesting } from "../../../src/config/secrets.js";
import { runWithContext } from "../../../src/request-context.js";

const ORIGIN = "https://site.example";
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function context(request: Request): APIContext {
	const download = vi.fn(async () => ({
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
				controller.close();
			},
		}),
		contentType: "image/png",
		size: 3,
	}));
	return {
		request,
		url: new URL(request.url),
		locals: { emdash: { storage: { download } } },
		cache: { enabled: true, set: vi.fn() },
		logger,
	} as unknown as APIContext;
}

describe("signed image URLs from render to the Node image endpoint", () => {
	beforeEach(() => {
		vi.stubEnv("EMDASH_IMAGE_SECRET", "secret-a");
		_clearSecretsCacheForTesting();
		globalThis.astroAsset = { imageService: service } as typeof globalThis.astroAsset;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
		_clearSecretsCacheForTesting();
	});

	it.each([
		["stored media", `${ORIGIN}/_emdash/api/media/file/abc.jpg`, "storage"],
		[
			"a bundled image",
			{ src: "/_astro/photo.abc123.jpg", width: 1200, height: 800, format: "jpg" },
			"stock",
		],
		["a remote image", "https://images.example.com/photo.jpg", "stock"],
	])("serves %s as rendered", async (_kind, src, servedBy) => {
		const image = await runWithContext({ editMode: false }, () =>
			getImage({ src, width: 800, height: 600, widths: [400, 800] } as never, imageConfig as never),
		);
		const urls = [image.src, ...image.srcSet.values.map((value) => value.url)];
		expect(image.srcSet.values).toHaveLength(2);

		for (const url of urls) {
			vi.mocked(genericGET).mockClear();
			const rendered = new URL(url, ORIGIN).href;
			const ctx = context(new Request(rendered));

			const response = await GET(ctx);

			expect(response.status, url).toBe(200);
			expect(response.headers.has("Location")).toBe(false);
			if (servedBy === "storage") {
				expect(genericGET).not.toHaveBeenCalled();
			} else {
				const [handed] = vi.mocked(genericGET).mock.calls[0] as unknown as [APIContext];
				expect(handed.request.url).toBe(rendered);
			}
		}
	});
});
