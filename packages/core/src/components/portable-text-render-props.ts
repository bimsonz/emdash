/**
 * The props of the `<PortableText>` that rendered a block, for a block that
 * renders Portable Text of its own. A type component receives only its node,
 * so they ride on the node as a non-enumerable property.
 */
const RENDER_PROPS = Symbol.for("emdash.portable-text-render-props");

export type PortableTextRenderProps = Record<string, unknown>;

/** Attach `props` to each block of a value that is about to render. */
export function attachRenderProps(blocks: unknown, props: PortableTextRenderProps): void {
	if (!Array.isArray(blocks)) return;
	for (const block of blocks) {
		if (typeof block === "object" && block !== null) {
			Object.defineProperty(block, RENDER_PROPS, { value: props });
		}
	}
}

export function renderPropsOf(node: unknown): PortableTextRenderProps | undefined {
	if (typeof node !== "object" || node === null) return undefined;
	return (node as { [RENDER_PROPS]?: PortableTextRenderProps })[RENDER_PROPS];
}
