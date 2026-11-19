import { describe, expect, it } from "vitest";

import {
	imageSigningEnabled,
	imagesEnabled,
} from "../../../../src/astro/integration/images-option.js";
import { buildSerializableConfig, emdash } from "../../../../src/astro/integration/index.js";

describe("buildSerializableConfig", () => {
	it("passes the update-check opt-out to the runtime config", () => {
		expect(buildSerializableConfig({ updateCheck: false }).updateCheck).toBe(false);
	});
});

describe("updateCheck option", () => {
	it("rejects an invalid minimum release age during integration setup", () => {
		expect(() => emdash({ updateCheck: { minimumReleaseAge: "soon" } })).toThrow(
			/updateCheck\.minimumReleaseAge.*soon/,
		);
		expect(() => emdash({ updateCheck: { minimumReleaseAge: "48h" } })).not.toThrow();
	});
});

describe("image signing config", () => {
	it("serializes imageSigning only for signedUrls: true", () => {
		expect(buildSerializableConfig({ images: { signedUrls: true } }).imageSigning).toBe(true);
		for (const images of [undefined, true, false, {}, { signedUrls: false }]) {
			expect(buildSerializableConfig({ images }).imageSigning).toBe(false);
		}
	});

	it("treats an images object as enabled", () => {
		expect(imagesEnabled({ signedUrls: true })).toBe(true);
		expect(imagesEnabled({})).toBe(true);
		expect(imagesEnabled(undefined)).toBe(true);
		expect(imagesEnabled(false)).toBe(false);
		expect(imageSigningEnabled({ signedUrls: true })).toBe(true);
		expect(imageSigningEnabled(true)).toBe(false);
	});
});
