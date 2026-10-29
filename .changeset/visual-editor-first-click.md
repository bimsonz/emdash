---
"emdash": patch
---

Fixes the first click into the visual editor putting the caret at the start of the body instead of where it was clicked: in Firefox always, and in Chromium when the body starts with a block such as an image. The editor no longer registers TipTap's `Focus` extension, whose `has-focus` classes nothing in the visual editor uses. They appeared when the editor took focus, which happens during the click, and ProseMirror then wrote the editor's opening selection over the caret the click had placed.
