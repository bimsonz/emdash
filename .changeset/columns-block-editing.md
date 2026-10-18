---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds editing for the columns block, so editors can lay blocks out side by side in the rich text editor. Columns imported from WordPress, which showed as a card that could not be edited, open as editable columns too.

Type `/columns` to insert two empty columns. In the editor a columns block shows as a map of its layout: one box per column, at its relative width, naming the column's first heading and the kinds of block it holds. Clicking a box opens that column below the map at the editor's full width; Done, or moving elsewhere in the page, closes it. Each column holds ordinary blocks, including another columns block, and each of its blocks has its own drag handle, insert button and block menu. Dragging a block onto a column's box moves it to that column. An open column's menu adds a column beside it, moves it earlier or later, makes it wide or wider, or deletes it, and the block's settings set the gap between the columns, their vertical alignment, and whether they wrap onto new rows instead of stacking on narrow screens.

The stored block is unchanged apart from new optional fields: `gap`, `verticalAlignment` and `wrap` on the block, and a `span` of 2 or 3 on a wide column. `Columns` from `emdash/ui` now renders each column's blocks with the components passed to `PortableText`, including site and plugin components, where it used only mark components before, and it needs no inline styles unless a column stores its own `width`.

Plain-text extraction for AI Search and Vectorize now includes the text inside columns, and media usage tracking includes images and videos inside columns. Media usage indexes written before this release are reported as stale rather than complete until they are rebuilt, so media used only in columns no longer looks safe to delete.
