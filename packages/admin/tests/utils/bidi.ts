import { i18n } from "@lingui/core";
import { onTestFinished } from "vitest";
import { cleanup } from "vitest-browser-react";

function restoreAttribute(element: Element, name: string, value: string | null) {
	if (value === null) element.removeAttribute(name);
	else element.setAttribute(name, value);
}

/**
 * Switches the admin to `locale`, with its source strings, until the test ends. Render under
 * `LocaleDirectionProvider` to lay out a right-to-left locale as the admin does: Kumo's dialogs
 * take their direction from it, not from the document.
 */
export function activateLocale(locale: string) {
	const root = document.documentElement;
	const lang = root.getAttribute("lang");
	const dir = root.getAttribute("dir");
	const previous = i18n.locale;
	i18n.loadAndActivate({ locale, messages: {} });
	onTestFinished(async () => {
		// Unmount first, or switching the locale back re-renders the tree and its
		// LocaleDirectionProvider writes the test's lang and dir onto the document again.
		await cleanup();
		i18n.activate(previous);
		restoreAttribute(root, "lang", lang);
		restoreAttribute(root, "dir", dir);
	});
}

/**
 * The left edge on screen of the first occurrence of `text` inside `element`, after the
 * bidirectional algorithm has ordered it. Pick text that occurs once.
 */
export function leftEdgeOf(element: Element, text: string): number {
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const start = node.textContent?.indexOf(text) ?? -1;
		if (start < 0) continue;
		const range = document.createRange();
		range.setStart(node, start);
		range.setEnd(node, start + text.length);
		return range.getBoundingClientRect().left;
	}
	throw new Error(`"${text}" is not in "${element.textContent}"`);
}
