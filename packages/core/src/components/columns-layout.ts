/**
 * How a columns block is laid out: the classes and style that `Columns.astro`
 * and the visual editor both give it, so a column being edited on the page
 * sits where it sits when published.
 */

const GAP_CLASSES: Record<string, string> = {
	none: "emdash-columns--gap-none",
	sm: "emdash-columns--gap-sm",
	lg: "emdash-columns--gap-lg",
};
const ALIGNMENT_CLASSES: Record<string, string> = {
	top: "emdash-columns--align-top",
	center: "emdash-columns--align-center",
	bottom: "emdash-columns--align-bottom",
};
const SPAN_CLASSES: Record<string, string> = {
	2: "emdash-column--span-2",
	3: "emdash-column--span-3",
};
const CSS_LENGTH = /^\d+(?:\.\d+)?(?:%|px|rem|em|ch|vw)$/;

// Allowlist lookups, so stored values can't inject class names or styles.
const classFor = (classes: Record<string, string>, value: unknown) =>
	(typeof value === "string" || typeof value === "number") && Object.hasOwn(classes, value)
		? classes[value]
		: undefined;

export function columnsClasses(block: {
	gap?: unknown;
	verticalAlignment?: unknown;
	wrap?: unknown;
}): string[] {
	return [
		"emdash-columns",
		classFor(GAP_CLASSES, block.gap),
		classFor(ALIGNMENT_CLASSES, block.verticalAlignment),
		block.wrap === true ? "emdash-columns--wrap" : undefined,
	].filter((name) => name !== undefined);
}

export function columnClasses(column: { span?: unknown }): string[] {
	return ["emdash-column", classFor(SPAN_CLASSES, column.span)].filter(
		(name) => name !== undefined,
	);
}

/** The legacy `width` a column starts from, when it is a CSS length. */
export function columnStyle(column: { width?: unknown }): string | undefined {
	return typeof column.width === "string" && CSS_LENGTH.test(column.width)
		? `flex-basis: ${column.width}`
		: undefined;
}
