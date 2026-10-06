---
"emdash": patch
---

Blocks inside a nesting block's columns now render with the components passed to `<PortableText>`, including site overrides and plugin block components. Before, a column always used EmDash's built-in set, so any custom block placed in a column rendered as a hidden unknown-type placeholder.
