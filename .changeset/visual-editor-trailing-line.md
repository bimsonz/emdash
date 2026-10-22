---
"emdash": patch
---

Fixes the visual editor saving a body nobody had edited when it ends in a block such as an image, a table or a plugin block. The editor adds an empty line after a final block on its first change, so clicking into the body and out again saved it as an edit.
