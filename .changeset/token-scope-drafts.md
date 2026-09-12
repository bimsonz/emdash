---
"emdash": patch
---

Fixes API tokens reading unpublished content regardless of scope. Every token is admin-owned, so the content read routes' role check let a token scoped to `content:read` list and fetch drafts, scheduled and trashed entries; a public site fed by such a token kept serving a page after it was unpublished. Reading non-published content through a token now also requires the `admin` scope, the same rule already applied to media usage counts. Session-authenticated requests are unchanged. Integrations that read drafts with a narrowly scoped token need the `admin` scope from this release.
