import { setupI18n } from "@lingui/core";
import { describe, expect, it } from "vitest";

import { formatDimensions } from "../../src/lib/media-utils";

const admin = (locale: string) => setupI18n({ locale, messages: { [locale]: {} } });

describe("formatDimensions", () => {
	it("writes width before height without thousands separators", () => {
		expect(formatDimensions(4032, 3024, admin("en"))).toBe("4032 × 3024");
		expect(formatDimensions(4032, 3024, admin("de"))).toBe("4032 × 3024");
	});

	it("uses the digits of the admin's language", () => {
		expect(formatDimensions(800, 600, admin("fa"))).toBe("۸۰۰ × ۶۰۰");
	});

	it.each([
		[undefined, 600],
		[800, undefined],
		[null, 600],
		[0, 600],
		[800, 0],
	])("returns nothing for a width of %s and a height of %s", (width, height) => {
		expect(formatDimensions(width, height, admin("en"))).toBeUndefined();
	});
});
