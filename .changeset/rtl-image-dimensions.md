---
"@emdash-cms/admin": patch
---

Fixes image dimensions reading height first in right-to-left languages in the media details panel, the crop tool's output size and the content editor's image and gallery panels. The width is on the left in every language, as it already was in the image field. The image panel's **Original** line no longer shows a width or height on its own when the other is unknown.
