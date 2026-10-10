const DOM_FIELD =
	/^(?:aria-|data-|class(?:name)?$|id$|role$|style$|on(?:animation(?:end|iteration|start)|beforeinput|blur|change|click|contextmenu|copy|cut|drag|drop|error|focus|input|key(?:down|press|up)|load|mouse(?:down|move|up)|paste|pointer(?:down|move|up)|scroll|submit|touch(?:end|move|start)|transition(?:cancel|end|run|start)|wheel)$)/i;

/**
 * The fields of a stored Portable Text object that are safe to carry through
 * an editor node's attributes: none of `excluded`, no prototype keys, and
 * nothing that could become a DOM attribute or event handler.
 */
export function safeFields(
	value: unknown,
	excluded: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter(
			([key]) =>
				!excluded.has(key) &&
				key !== "__proto__" &&
				key !== "prototype" &&
				key !== "constructor" &&
				!DOM_FIELD.test(key),
		),
	);
}
