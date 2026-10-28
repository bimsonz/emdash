---
"@emdash-cms/blocks": minor
"@emdash-cms/admin": minor
"emdash": minor
---

Adds a `url_input` Block Kit element for link fields, such as a plugin block's button destination. It stores the link as a string: a URL, a site-relative path, or a fragment. In the admin's Portable Text block form it is the rich text editor's link control, so an editor can type or paste a URL, or search the site's content by title and pick an entry to store its public URL; a bare domain gets `https://`. The visual editor's block settings show it as a URL field. `elements.urlInput()` builds one.
