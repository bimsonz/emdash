---
"emdash": minor
"@emdash-cms/admin": minor
---

Shows plugin blocks in the visual editor as the page renders them. A page renders each plugin block of the body it is editing into `BlockPreview` (from `emdash/ui`), and the editor shows that markup, read-only, in place of the "Plugin block: … (edit in admin)" placeholder, with an "Edit block" link that opens the block's settings in the admin (`?block=` on the content edit route). Blocks the page does not preview keep the placeholder. Blocks are named by a content key (`@emdash-cms/admin/plugin-block-key`), since both editors write a fresh `_key` on save.
