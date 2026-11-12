---
"@emdash-cms/admin": patch
---

Fixes the Edit button of a plugin block that declares `fields: []`. The block's card in the editor read an empty `fields` array as the URL-embed shape, as the insert modal once did, so Edit opened a URL box that would store whatever was typed as the block's id. It now opens the block's dialog, which says the block has nothing to fill in.
