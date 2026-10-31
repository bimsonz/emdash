/**
 * Links written into a plain text field as `[words](address)`. A field opts in with `links: true`;
 * the stored value stays a string, and a site that shows the field reads the links out of it.
 */
export interface TextLink {
	start: number;
	end: number;
	words: string;
	href: string;
}

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** `[words](address)`, with what would end either part early taken out of it. */
function linkSource(words: string, href: string): string {
	const text = words.replace(/\]/g, "").replace(/\s*\n\s*/g, " ");
	const address = href.replace(/\)/g, "%29").replace(/\s/g, "%20");
	return `[${text}](${address})`;
}

/** The link holding the caret or the whole selection. A caret at either edge of a link is in it. */
export function linkAt(text: string, from: number, to: number): TextLink | undefined {
	for (const match of text.matchAll(LINK)) {
		const start = match.index;
		const end = start + match[0].length;
		if (from >= start && to <= end) return { start, end, words: match[1]!, href: match[2]! };
	}
	return undefined;
}

/** The text with `from` to `to` replaced by a link, and where the caret goes after it. */
export function insertLink(text: string, from: number, to: number, words: string, href: string) {
	const link = linkSource(words, href);
	return { text: text.slice(0, from) + link + text.slice(to), caret: from + link.length };
}

/** The text with a link back to its words. */
export function unlink(text: string, link: TextLink) {
	return {
		text: text.slice(0, link.start) + link.words + text.slice(link.end),
		caret: link.start + link.words.length,
	};
}
