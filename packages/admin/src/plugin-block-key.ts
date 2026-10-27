/**
 * A plugin block's content key: the same string for a Portable Text block and for the editor node
 * it becomes, so a page, the visual editor and the admin can name one block without its `_key`
 * (both editors write a fresh `_key` on every save).
 *
 * Two blocks with identical fields share a key. That is what a preview wants: they render the same.
 */

/** The fields of a Portable Text plugin block, as stored. */
export interface PluginBlockLike {
	_type?: unknown;
	[field: string]: unknown;
}

/** A `pluginBlock` editor node's attributes, as both editors' converters write them. */
export interface PluginBlockAttrs {
	blockType?: unknown;
	id?: unknown;
	identityField?: unknown;
	data?: unknown;
}

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** cyrb53: a fast 53-bit string hash, plenty for the blocks on one page. */
function hash(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The key of a stored block: its type and every field not starting with `_`. */
export function pluginBlockKey(block: PluginBlockLike): string {
	const type = typeof block._type === "string" ? block._type : "embed";
	const fields = Object.fromEntries(Object.entries(block).filter(([k]) => !k.startsWith("_")));
	return `${type}-${hash(stable(fields))}`;
}

/** The key of an editor node, equal to `pluginBlockKey` of the block it came from. */
export function pluginBlockKeyFromAttrs(attrs: PluginBlockAttrs): string {
	const data = attrs.data && typeof attrs.data === "object" ? attrs.data : {};
	const field = attrs.identityField;
	const identity =
		typeof field === "string" && field !== "" && typeof attrs.id === "string"
			? { [field]: attrs.id }
			: {};
	return pluginBlockKey({ ...data, ...identity, _type: attrs.blockType });
}
