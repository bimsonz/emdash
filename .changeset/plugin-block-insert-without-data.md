---
"@emdash-cms/admin": patch
---

Fixes plugin blocks that could not be inserted from the editor: one whose fields are all optional and left empty, and one declaring `fields: []` because it takes no configuration. The insert modal required at least one field to hold a value, which no Block Kit element can require or waive, and read an empty `fields` array as the URL-embed shape. A declared `fields` array now always means Block Kit mode and the block can be inserted as is; URL embeds still need a URL.
