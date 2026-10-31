import { describe, expect, it } from "vitest";

import { insertLink, linkAt, unlink } from "../../../src/components/inline-text-links.js";

/** The site's reader of these links: what's written must come back as written. */
const READER = /\[([^\]\n]+)\]\(([^)\s]+)\)/;

describe("insertLink", () => {
	it("replaces the selection and leaves the caret after the link", () => {
		expect(insertLink("take the bus now", 9, 12, "bus", "https://x.co")).toEqual({
			text: "take the [bus](https://x.co) now",
			caret: 28,
		});
	});

	it("adds at a caret when nothing is selected", () => {
		expect(insertLink("See ", 4, 4, "the map", "/map")).toEqual({
			text: "See [the map](/map)",
			caret: 19,
		});
	});

	it.each([
		["a bracket in the words", "a]b", "/x", "ab", "/x"],
		["a line break in the words", "two\nlines", "/x", "two lines", "/x"],
		["a closing bracket in the address", "w", "https://x.co/a_(b)", "w", "https://x.co/a_(b%29"],
		["a space in the address", "w", "/a b", "w", "/a%20b"],
	])("writes %s so it still reads as one link", (_, words, href, wantWords, wantHref) => {
		const match = READER.exec(insertLink("", 0, 0, words, href).text);
		expect(match?.[1]).toBe(wantWords);
		expect(match?.[2]).toBe(wantHref);
	});
});

describe("linkAt", () => {
	const text = "go to [the map](/map) or [prices](/prices) today";

	it.each([
		["the caret inside the words", 10, 10, "the map"],
		["the caret inside the address", 17, 17, "the map"],
		["the caret on the opening bracket", 6, 6, "the map"],
		["the caret just after the link", 21, 21, "the map"],
		["a selection inside the link", 7, 14, "the map"],
		["the caret in the second link", 28, 28, "prices"],
	])("finds the link for %s", (_, from, to, words) => {
		expect(linkAt(text, from, to)?.words).toBe(words);
	});

	it("reports where the link is and where it goes", () => {
		expect(linkAt(text, 10, 10)).toEqual({ start: 6, end: 21, words: "the map", href: "/map" });
	});

	it.each([
		["a caret before any link", 2, 2],
		["a caret between two links", 23, 23],
		["a selection running past the link", 10, 24],
	])("finds nothing for %s", (_, from, to) => {
		expect(linkAt(text, from, to)).toBeUndefined();
	});

	it("doesn't find a link in text with none", () => {
		expect(linkAt("just [words] and (more)", 7, 7)).toBeUndefined();
	});
});

describe("unlink", () => {
	it("leaves the words and the caret after them", () => {
		const text = "see [the map](/map) now";
		expect(unlink(text, { start: 4, end: 19, words: "the map", href: "/map" })).toEqual({
			text: "see the map now",
			caret: 11,
		});
	});
});
