/**
 * `emdash/image-service` -- the image service EmDash installs over the stock
 * runtime service (Astro's sharp, or the Cloudflare adapter's workerd service)
 * when `images: { signedUrls: true }` is on.
 *
 * Every method delegates to the stock service with the stock service's own
 * `imageConfig.service`. `getURL` also signs each transform URL it builds while
 * EmDash renders a request, so the image endpoint can refuse URLs it did not
 * build. Astro awaits `getURL` for an image's `src` and for each `srcset`
 * candidate, so both are signed.
 */

import type { LocalImageService } from "astro";
import virtualConfig from "virtual:emdash/config";
import stockImageService from "virtual:emdash/stock-image-service";

import { signTransformUrl } from "../media/image-signature.js";
import { resolveImageSigningKeys } from "../media/image-signing-keys.js";
import { getRequestContext } from "../request-context.js";

type ImageConfig = Parameters<LocalImageService["getURL"]>[1];

/** Base for parsing the root-relative URLs a stock service builds. */
const PLACEHOLDER_ORIGIN = "http://emdash.invalid";

function recordedStockService(): ImageConfig["service"] {
	const recorded = virtualConfig.imageRuntimeService;
	if (!recorded) {
		throw new Error(
			"[emdash] emdash/image-service is installed by EmDash for images.signedUrls, not configured directly.",
		);
	}
	return recorded;
}

/**
 * Wraps `stock` so each method sees `original` as `imageConfig.service`, as it
 * would unwrapped (sharp reads its `kernel` there), and `getURL` signs.
 */
function signingImageService(
	stock: LocalImageService,
	original: ImageConfig["service"],
): LocalImageService {
	const stockConfig = (imageConfig: ImageConfig): ImageConfig => ({
		...imageConfig,
		service: original,
	});

	const service: LocalImageService = {
		...stock,
		async getURL(options, imageConfig, logger) {
			const url = await stock.getURL(options, stockConfig(imageConfig), logger);
			// Sign only while rendering a request. Prerendering at build needs no secret.
			const context = getRequestContext();
			if (!context || context.prerendering) return url;
			// A source the stock service won't transform comes back as it is. It
			// doesn't address the image endpoint, so there is nothing to sign.
			if (url === options.src) return url;
			const [signingKey] = await resolveImageSigningKeys();
			return signTransformUrl(
				new URL(url, PLACEHOLDER_ORIGIN),
				signingKey,
				imageConfig.assetQueryParams,
			);
		},
		parseURL: (url, imageConfig, logger) => stock.parseURL(url, stockConfig(imageConfig), logger),
		transform: (inputBuffer, transform, imageConfig, logger) =>
			stock.transform(inputBuffer, transform, stockConfig(imageConfig), logger),
	};

	// Optional methods stay absent when the stock service has none, so Astro keeps its defaults.
	const { validateOptions, getHTMLAttributes, getSrcSet, getRemoteSize } = stock;
	if (validateOptions) {
		service.validateOptions = (options, imageConfig, logger) =>
			validateOptions.call(stock, options, stockConfig(imageConfig), logger);
	}
	if (getHTMLAttributes) {
		service.getHTMLAttributes = (options, imageConfig, logger) =>
			getHTMLAttributes.call(stock, options, stockConfig(imageConfig), logger);
	}
	if (getSrcSet) {
		service.getSrcSet = (options, imageConfig, logger) =>
			getSrcSet.call(stock, options, stockConfig(imageConfig), logger);
	}
	if (getRemoteSize) {
		service.getRemoteSize = (url, imageConfig, logger) =>
			getRemoteSize.call(stock, url, stockConfig(imageConfig), logger);
	}
	return service;
}

export default signingImageService(stockImageService, recordedStockService());
