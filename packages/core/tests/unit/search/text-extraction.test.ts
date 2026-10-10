import { describe, expect, it } from "vitest";

import { extractPlainText } from "../../../src/search/text-extraction.js";

describe("extractPlainText", () => {
	it("includes video captions", () => {
		const text = extractPlainText([
			{
				_type: "video",
				_key: "video1",
				asset: { _ref: "01VIDEO" },
				caption: "Keynote recording",
			},
		]);

		expect(text).toBe("Keynote recording");
	});

	it("leaves the caption of a plugin's video block alone", () => {
		const text = extractPlainText([
			{
				_type: "video",
				_key: "video1",
				asset: { _ref: "01VIDEO" },
				autoplay: true,
				caption: "Internal note",
			},
		]);

		expect(text).toBe("");
	});
	it("includes the text inside columns, including columns nested in a column", () => {
		const paragraph = (key: string, text: string) => ({
			_type: "block",
			_key: key,
			children: [{ _type: "span", _key: `${key}s`, text }],
		});
		const text = extractPlainText([
			paragraph("intro", "Before the columns"),
			{
				_type: "columns",
				_key: "cols",
				columns: [
					{ _type: "column", _key: "c1", content: [paragraph("a", "Opening hours")] },
					{
						_type: "column",
						_key: "c2",
						content: [
							{
								_type: "columns",
								_key: "inner",
								columns: [
									{
										_type: "column",
										_key: "c3",
										content: [{ _type: "image", _key: "img", alt: "The climbing wall" }],
									},
								],
							},
						],
					},
				],
			},
		]);

		expect(text.split(/\n+/)).toEqual(["Before the columns", "Opening hours", "The climbing wall"]);
	});
});
