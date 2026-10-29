---
"emdash": minor
"@emdash-cms/admin": minor
---

Edits plugin blocks in the visual editor as the page renders them. A page renders each plugin block of the body it is editing into `BlockPreview` (from `emdash/ui`), and the editor shows that markup in its place, running as it does on the page: islands hydrate and scripts run, while links and forms stay put. The markup is drawn in a shadow root, out of reach of the editor's styles; a part marked `data-emdash-in-document`, such as a third-party embed whose script looks for its element or frame through `document`, stays in the document, drawn in its place. A bar on each block opens its settings on the page, in the same Block Kit form the admin shows, and moves or deletes it; the slash menu inserts plugin blocks the same way. Once a block's settings are saved, the editor fetches the page again, which edit mode renders from the draft, to redraw the block. A block the page does not preview shows as a slot naming it and what it is set to. Blocks are named by a content key (`@emdash-cms/admin/plugin-block-key`), since both editors write a fresh `_key` on save.
