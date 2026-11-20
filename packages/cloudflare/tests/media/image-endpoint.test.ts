import type { APIContext } from "astro";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fakeEnv, adapterGET, imageConfig, virtualConfig } = vi.hoisted(() => ({
	virtualConfig: {} as {
		routeCacheProvider?: string;
		imageSigning?: boolean;
		imageRuntimeService?: { entrypoint: string; config: Record<string, unknown> };
	},
	fakeEnv: {} as Record<string, unknown>,
	adapterGET: vi.fn(async () => new Response("adapter", { status: 418 })),
	imageConfig: {
		service: { entrypoint: "@astrojs/cloudflare/image-service-workerd" },
	} as { service: { entrypoint: string }; assetQueryParams?: URLSearchParams },
}));

vi.mock("virtual:emdash/config", () => ({ default: virtualConfig }));
vi.mock("cloudflare:workers", () => ({ env: fakeEnv }));
vi.mock("astro:assets", () => ({ imageConfig }));
vi.mock("@astrojs/cloudflare/image-transform-endpoint", () => ({ GET: adapterGET }));
vi.mock("../../../core/src/loader.js", () => ({ getDb: vi.fn(async () => ({})) }));
vi.mock("../../../core/src/config/secrets.js", () => ({
	readImageSigningSecretsFromEnv: () => null,
	resolveImageSigningSecrets: vi.fn(async () => ({ secrets: ["secret-a"], source: "db" })),
}));
// Core source is imported through a variable specifier so tsgo does not compile
// it under this package's stricter options.
const { CORE_SRC, CORE_ASTRO_SRC } = vi.hoisted(() => ({
	CORE_SRC: new URL("../../../core/src/media/", import.meta.url).pathname,
	CORE_ASTRO_SRC: new URL("../../../core/src/astro/", import.meta.url).pathname,
}));
vi.mock(
	"emdash/media/image-endpoint",
	async () => import(/* @vite-ignore */ `${CORE_SRC}image-endpoint.js`),
);
vi.mock(
	"emdash/internal/image-signing",
	async () => import(/* @vite-ignore */ `${CORE_ASTRO_SRC}image-signing.js`),
);

import { GET } from "../../src/image-endpoint.js";

const sourceBytes = new TextEncoder().encode("source");
const transformedBytes = new TextEncoder().encode("transformed");

function context(query: string, contentType = "image/jpeg") {
	const input = {
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(sourceBytes);
				controller.close();
			},
		}),
		contentType,
		size: sourceBytes.length,
		downloads: 0,
	};
	const storage = {
		download: vi.fn(async () => {
			input.downloads++;
			return input;
		}),
	};
	return {
		input,
		storage,
		ctx: {
			request: new Request(
				`https://example.test/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fphoto.jpg${query ? `&${query}` : ""}`,
			),
			locals: { emdash: { storage } },
			cache: { enabled: true, set: vi.fn() },
		},
	};
}

function installImages() {
	const transform = vi.fn();
	const output = vi.fn(async (options: ImageOutputOptions) => ({
		response: () =>
			new Response(transformedBytes, {
				headers: { "Content-Type": options.format },
			}),
	}));
	const images = {
		input: vi.fn(() => ({
			transform: (params: ImageTransform) => {
				transform(params);
				return { output };
			},
		})),
	};
	fakeEnv.IMAGES = images;
	return { images, transform, output };
}

afterEach(() => {
	for (const key of Object.keys(fakeEnv)) delete fakeEnv[key];
	delete imageConfig.assetQueryParams;
	imageConfig.service.entrypoint = "@astrojs/cloudflare/image-service-workerd";
	delete virtualConfig.routeCacheProvider;
	delete virtualConfig.imageSigning;
	delete virtualConfig.imageRuntimeService;
	vi.clearAllMocks();
});

describe("Cloudflare image endpoint", () => {
	it.each([
		["low", 25],
		["mid", 50],
		["high", 80],
		["max", 100],
		["70.6", 71],
		["80.5", 81],
		["0", 1],
		["101", 100],
		["150", 100],
	])("passes parsed quality %s to Images", async (q, quality) => {
		const { images, transform, output } = installImages();
		const { ctx } = context(`w=120&q=${q}`);

		const response = await GET(ctx as never);

		expect(response.status).toBe(200);
		expect(images.input).toHaveBeenCalledOnce();
		expect(transform).toHaveBeenCalledWith({ width: 120 });
		expect(output).toHaveBeenCalledWith({ format: "image/webp", quality });
		expect(await response.text()).toBe("transformed");
	});

	it.each([
		"/_emdash/api/media/file/photo.jpg?buster=1",
		"/_emdash/api/media/file/photo.jpg?buster=2",
		"/_emdash/api/media/file/photo.jpg?_emdash_media=hash",
		"/_emdash/api/media/file/photo.jpg#preview",
		"/_emdash/api/media/file/photo.jpg?",
		"/_emdash/api/media/file/photo.jpg#",
		"https://other.test/_emdash/api/media/file/photo.jpg",
		"https://user@example.test/_emdash/api/media/file/photo.jpg",
		"//example.test/_emdash/api/media/file/photo.jpg",
	])("serves source URL %s without storing another cache entry", async (href) => {
		installImages();
		const { ctx } = context("w=120");
		const url = new URL(ctx.request.url);
		url.searchParams.set("href", href);
		ctx.request = new Request(url);

		const response = await GET(ctx as never);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("transformed");
		expect(ctx.cache.set).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"preserves custom-service parameters with cache enabled=%s",
		async (enabled) => {
			installImages();
			imageConfig.service.entrypoint = "./custom-image-service.ts";
			const { ctx } = context("w=120&size=thumbnail");
			ctx.cache.enabled = enabled;

			const response = await GET(ctx as never);

			expect(response.status).toBe(200);
			expect(response.headers.has("Location")).toBe(false);
			expect(await response.text()).toBe("transformed");
			expect(ctx.cache.set).not.toHaveBeenCalled();
		},
	);

	it("serves a variant without caching when the provider is memory", async () => {
		installImages();
		virtualConfig.routeCacheProvider = "memory";
		const { ctx } = context("w=120");

		const response = await GET(ctx as never);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("transformed");
		expect(ctx.cache.set).not.toHaveBeenCalled();
	});

	it("caches a plain same-origin absolute source URL", async () => {
		installImages();
		const { ctx } = context("w=120");
		const url = new URL(ctx.request.url);
		url.searchParams.set("href", "https://example.test/_emdash/api/media/file/photo.jpg");
		ctx.request = new Request(url);

		const response = await GET(ctx as never);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("transformed");
		expect(ctx.cache.set).toHaveBeenCalledOnce();
	});

	it("stores a transformed variant in the route cache under its storage key", async () => {
		installImages();
		const { ctx } = context("w=120");

		const response = await GET(ctx as never);

		expect(response.status).toBe(200);
		expect(ctx.cache.set).toHaveBeenCalledWith({
			maxAge: 31_536_000,
			tags: ["emdash:media:photo.jpg"],
		});
	});

	it("does not cache the original fallback for malformed params", async () => {
		installImages();
		const { ctx } = context("w=120&q=unknown");

		await GET(ctx as never);

		expect(ctx.cache.set).not.toHaveBeenCalled();
	});

	it("redirects a non-canonical query without reading storage or caching", async () => {
		const { images } = installImages();
		const { ctx, storage } = context("x=1&w=120");

		const response = await GET(ctx as never);

		expect(response.status).toBe(301);
		expect(response.headers.get("Location")).toBe(
			"/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fphoto.jpg&w=120",
		);
		expect(storage.download).not.toHaveBeenCalled();
		expect(images.input).not.toHaveBeenCalled();
		expect(ctx.cache.set).not.toHaveBeenCalled();
	});

	describe("under the signing image service", () => {
		const workerd = { entrypoint: "@astrojs/cloudflare/image-service-workerd", config: {} };

		it("redirects a non-canonical query as the workerd service would", async () => {
			imageConfig.service.entrypoint = "emdash/internal/image-service";
			virtualConfig.imageRuntimeService = workerd;
			const { images } = installImages();
			const { ctx, storage } = context("x=1&w=120");

			const response = await GET(ctx as never);

			expect(response.status).toBe(301);
			expect(response.headers.get("Location")).toBe(
				"/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fphoto.jpg&w=120",
			);
			expect(storage.download).not.toHaveBeenCalled();
			expect(images.input).not.toHaveBeenCalled();
		});

		it("caches a transformed variant as the workerd service would", async () => {
			imageConfig.service.entrypoint = "emdash/internal/image-service";
			virtualConfig.imageRuntimeService = workerd;
			installImages();
			const { ctx } = context("w=120");

			const response = await GET(ctx as never);

			expect(response.status).toBe(200);
			expect(ctx.cache.set).toHaveBeenCalledWith(
				expect.objectContaining({ tags: ["emdash:media:photo.jpg"] }),
			);
		});

		it("treats it as custom when no stock service was recorded", async () => {
			imageConfig.service.entrypoint = "emdash/internal/image-service";
			installImages();
			const { ctx } = context("x=1&w=120");

			const response = await GET(ctx as never);

			expect(response.status).toBe(200);
			expect(ctx.cache.set).not.toHaveBeenCalled();
		});
	});

	it("serves a URL that ends in the adapter's asset query params without redirecting", async () => {
		installImages();
		imageConfig.assetQueryParams = new URLSearchParams({ dpl: "abc" });
		const { ctx } = context("w=120&dpl=abc");

		const response = await GET(ctx as never);

		expect(response.status).toBe(200);
		expect(ctx.cache.set).toHaveBeenCalledWith(
			expect.objectContaining({ tags: ["emdash:media:photo.jpg"] }),
		);
	});

	it("hands a non-EmDash image to the adapter without redirecting", async () => {
		installImages();
		const { ctx, storage } = context("");
		ctx.request = new Request("https://example.test/_image?x=1&w=120&href=%2F_astro%2Flogo.png");

		const response = await GET(ctx as never);

		expect(response.status).toBe(418);
		expect(adapterGET).toHaveBeenCalledOnce();
		expect((adapterGET.mock.calls[0] as unknown[])[0]).toBe(ctx);
		expect(storage.download).not.toHaveBeenCalled();
		expect(ctx.cache.set).not.toHaveBeenCalled();
	});

	it("does not cache a failed transform", async () => {
		const { output } = installImages();
		output.mockRejectedValueOnce(new Error("Images unavailable"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { ctx } = context("w=120");

		const response = await GET(ctx as never);

		expect(response.status).toBe(500);
		expect(ctx.cache.set).not.toHaveBeenCalled();
	});

	it("uses the Images default quality for an omitted q", async () => {
		const { output } = installImages();
		const { ctx } = context("w=120");

		await GET(ctx as never);

		expect(output).toHaveBeenCalledWith({ format: "image/webp", quality: 85 });
	});

	it.each(["w=120&q=unknown", "", "w=120&f=gif"])(
		"preserves the original fallback for malformed query %s",
		async (query) => {
			const { images } = installImages();
			const { ctx } = context(query);

			const response = await GET(ctx as never);

			expect(response.status).toBe(200);
			expect(await response.text()).toBe("source");
			expect(images.input).not.toHaveBeenCalled();
		},
	);

	it("streams the original when Images is unavailable", async () => {
		const { ctx } = context("w=120&q=70");

		const response = await GET(ctx as never);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("source");
		expect(adapterGET).not.toHaveBeenCalled();
	});

	it.each(["w=120&q=70", "w=120&q=unknown"])(
		"passes non-image media through unchanged for %s",
		async (query) => {
			installImages();
			const { ctx } = context(query, "application/pdf");

			const response = await GET(ctx as never);

			expect(response.status).toBe(200);
			expect(await response.text()).toBe("source");
		},
	);
});

interface TrackedBody {
	stream: ReadableStream<Uint8Array>;
	cancelled: () => boolean;
}

function trackedBody(): TrackedBody {
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new Uint8Array([1, 2, 3]));
			controller.close();
		},
		cancel() {
			cancelled = true;
		},
	});
	return { stream, cancelled: () => cancelled };
}

const fakeImages = {
	input: (stream: ReadableStream<Uint8Array>) => ({
		transform: () => ({
			output: async () => ({ response: () => new Response(stream) }),
		}),
	}),
};

const failingImages = {
	input: () => ({
		transform: () => ({
			output: async () => {
				throw new Error("unsupported image");
			},
		}),
	}),
};

async function request(options: {
	contentType: string;
	query: string;
	method?: string;
	headers?: Record<string, string>;
}): Promise<{ response: Response; body: TrackedBody }> {
	const body = trackedBody();
	const storage = {
		download: async () => ({
			body: body.stream,
			contentType: options.contentType,
			size: 3,
			lastModified: new Date("2026-01-01T00:00:00Z"),
		}),
	};
	const url = `https://site.test/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fa.bin&${options.query}`;
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the endpoint reads only request and locals
	const ctx = {
		request: new Request(url, { method: options.method ?? "GET", headers: options.headers }),
		locals: { emdash: { storage } },
	} as unknown as APIContext;
	const response = await GET(ctx);
	return { response, body };
}

describe("cloudflare image endpoint storage body", () => {
	afterEach(() => {
		delete fakeEnv.IMAGES;
		vi.restoreAllMocks();
	});

	it.each([
		["a non-image", "application/pdf", "w=100", false],
		["an image without an Images binding", "image/png", "w=100", false],
		["an image with invalid transform params", "image/png", "w=abc", true],
		["a transformed image", "image/png", "w=100&f=webp", true],
	])(
		"cancels the download for a conditional GET of %s",
		async (_label, contentType, query, binding) => {
			if (binding) fakeEnv.IMAGES = fakeImages;
			const { response, body } = await request({
				contentType,
				query,
				headers: { "If-None-Match": "*" },
			});
			expect(response.status).toBe(304);
			expect(body.cancelled()).toBe(true);
		},
	);

	it.each([
		["a non-image", "application/pdf", "w=100"],
		["an image without an Images binding", "image/png", "w=100"],
	])(
		"cancels the download and sends no body for a HEAD of %s",
		async (_label, contentType, query) => {
			const { response, body } = await request({ contentType, query, method: "HEAD" });
			expect(response.status).toBe(200);
			expect(response.body).toBeNull();
			expect(response.headers.get("Content-Type")).toBe(contentType);
			expect(body.cancelled()).toBe(true);
		},
	);

	it("streams the original body for a GET of a non-image", async () => {
		const { response, body } = await request({ contentType: "application/pdf", query: "w=100" });
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
		expect(body.cancelled()).toBe(false);
	});

	it("hands the download to the Images binding for a transform", async () => {
		fakeEnv.IMAGES = fakeImages;
		const { response, body } = await request({ contentType: "image/png", query: "w=100&f=webp" });
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
		expect(body.cancelled()).toBe(false);
	});

	it("cancels the download when the Images binding fails without reading it", async () => {
		fakeEnv.IMAGES = failingImages;
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { response, body } = await request({ contentType: "image/png", query: "w=100&f=webp" });
		expect(response.status).toBe(500);
		expect(body.cancelled()).toBe(true);
	});
});

describe("Cloudflare image endpoint with signed image URLs", () => {
	const HREF = "/_emdash/api/media/file/photo.jpg";

	async function signedPath(href = HREF, assetQueryParams?: URLSearchParams): Promise<string> {
		const { importImageSigningKeys, signTransformUrl } = (await import(
			/* @vite-ignore */ `${CORE_SRC}image-signature.js`
		)) as {
			importImageSigningKeys(secrets: string[]): Promise<CryptoKey[]>;
			signTransformUrl(
				url: URL,
				key: CryptoKey,
				assetQueryParams?: URLSearchParams,
			): Promise<string>;
		};
		const [key] = await importImageSigningKeys(["secret-a"]);
		return signTransformUrl(
			new URL(`https://example.test/_image?href=${encodeURIComponent(href)}&w=640`),
			key!,
			assetQueryParams,
		);
	}

	function signedContext(path: string) {
		const { ctx, storage, input } = context("");
		ctx.request = new Request(`https://example.test${path}`);
		return { ctx, storage, input };
	}

	it("refuses an unsigned stored-media request without reading storage or transforming", async () => {
		const { images } = installImages();
		const { ctx, storage } = signedContext(`/_image?href=${encodeURIComponent(HREF)}&w=640`);

		virtualConfig.imageSigning = true;
		const response = await GET(ctx as never);

		expect(response.status).toBe(403);
		expect(response.headers.get("Cache-Control")).toContain("no-store");
		expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
			"IMAGE_SIGNATURE_INVALID",
		);
		expect(storage.download).not.toHaveBeenCalled();
		expect(images.input).not.toHaveBeenCalled();
		expect(ctx.cache.set).not.toHaveBeenCalled();
	});

	it("serves a signed request", async () => {
		const { images } = installImages();
		virtualConfig.imageSigning = true;
		const { ctx } = signedContext(await signedPath());
		const response = await GET(ctx as never);
		expect(response.status).toBe(200);
		expect(images.input).toHaveBeenCalledTimes(1);
	});

	it("redirects a reordered signed request and keeps the signature", async () => {
		virtualConfig.imageSigning = true;
		const path = await signedPath();
		const sig = new URL(path, "https://example.test").searchParams.get("_emdash_sig")!;
		const { ctx, storage } = signedContext(
			`/_image?w=640&_emdash_sig=${sig}&href=${encodeURIComponent(HREF)}`,
		);
		const response = await GET(ctx as never);
		expect(response.status).toBe(301);
		expect(response.headers.get("Location")).toBe(path);
		expect(storage.download).not.toHaveBeenCalled();
	});

	it("refuses every unsigned href form, whatever it resolves to, without reaching the adapter", async () => {
		const { images } = installImages();
		virtualConfig.imageSigning = true;
		const hrefs = [
			"/_emdash/api/media/file/photo.jpg/",
			"/_emdash/api/media/file/%70hoto.jpg",
			"https://example.test/_emdash/api/media/file/photo.jpg/",
			"https://media.example.com:8443/uploads/photo.jpg",
			"https:/_emdash/api/media/file/abc.jpg",
			"http:media.example.com/uploads/a.jpg",
			"/blog/_emdash/api/media/file/abc.jpg",
			"/old-redirect",
			"/_astro/foo.hash.jpg",
			"https://cdn.example.com/a.jpg",
		];
		for (const href of hrefs) {
			const { ctx, storage } = signedContext(`/_image?href=${encodeURIComponent(href)}&w=640`);
			const response = await GET(ctx as never);
			expect(response.status, href).toBe(403);
			expect(storage.download).not.toHaveBeenCalled();
		}
		const { ctx } = signedContext("/_image?w=640");
		expect((await GET(ctx as never)).status).toBe(403);
		expect(adapterGET).not.toHaveBeenCalled();
		expect(images.input).not.toHaveBeenCalled();
	});

	it("hands a signed non-media href to the adapter endpoint", async () => {
		virtualConfig.imageSigning = true;
		const { ctx } = signedContext(await signedPath("/_astro/a.png"));
		expect((await GET(ctx as never)).status).toBe(418);
		expect(adapterGET).toHaveBeenCalledTimes(1);
	});

	it.each([
		["a bundled image", "foo=1", "/_astro/a.png"],
		["a remote image", "blur=5", "https://images.example.com/a.jpg"],
		["a bundled image", "w=4000", "/_astro/a.png"],
	])("hands %s to the adapter endpoint without the unsigned %s", async (_kind, unsigned, href) => {
		virtualConfig.imageSigning = true;
		const path = await signedPath(href);
		const { ctx } = signedContext(`${path}&${unsigned}`);
		ctx.request = new Request(ctx.request.url, { headers: { Accept: "image/avif" } });

		expect((await GET(ctx as never)).status).toBe(418);

		const [handed] = adapterGET.mock.calls[0] as unknown as [APIContext];
		expect(handed.request.url).toBe(`https://example.test${path}`);
		expect(handed.url.href).toBe(`https://example.test${path}`);
		expect(handed.request.headers.get("Accept")).toBe("image/avif");
		expect(handed.locals).toBe(ctx.locals);
	});

	it.each([
		["stored media", HREF],
		["a bundled image", "/_astro/a.png"],
		["a remote image", "https://images.example.com/a.jpg"],
	])("serves a signed URL for %s as it was rendered, without a redirect", async (_kind, href) => {
		const { images } = installImages();
		virtualConfig.imageSigning = true;
		imageConfig.assetQueryParams = new URLSearchParams({ dpl: "abc" });
		const { ctx } = signedContext(await signedPath(href, imageConfig.assetQueryParams));

		const response = await GET(ctx as never);

		expect(response.headers.has("Location")).toBe(false);
		if (href === HREF) {
			expect(response.status).toBe(200);
			expect(images.input).toHaveBeenCalledOnce();
		} else {
			expect(response.status).toBe(418);
			expect((adapterGET.mock.calls[0] as unknown[])[0]).toBe(ctx);
		}
	});

	it("redirects a signed URL to its unsigned canonical form when signing is off", async () => {
		const { ctx, storage } = signedContext(await signedPath());
		const response = await GET(ctx as never);
		expect(response.status).toBe(301);
		expect(response.headers.get("Location")).toBe(`/_image?href=${encodeURIComponent(HREF)}&w=640`);
		expect(storage.download).not.toHaveBeenCalled();
	});
});
