import { describe, expect, it } from "vitest";

import { timingSafeEqualString } from "../../../src/utils/constant-time.js";

describe("timingSafeEqualString", () => {
	it("is true for equal strings", async () => {
		expect(await timingSafeEqualString("abc123", "abc123")).toBe(true);
		expect(await timingSafeEqualString("", "")).toBe(true);
	});

	it("is false for different strings", async () => {
		expect(await timingSafeEqualString("abc123", "abc124")).toBe(false);
	});

	it("is false for different lengths", async () => {
		expect(await timingSafeEqualString("abc", "abcd")).toBe(false);
		expect(await timingSafeEqualString("", "a")).toBe(false);
	});
});
