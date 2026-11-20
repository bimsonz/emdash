---
"emdash": minor
"@emdash-cms/cloudflare": minor
---

Adds an opt-in `images: { signedUrls: true }` setting that signs every image transform URL EmDash renders and refuses unsigned requests, so the image endpoint creates only the variants your pages use instead of any width, height and quality a request names. It is off by default and changes nothing until you set it.

```js
emdash({
	images: { signedUrls: true },
});
```

With signing on, stored media, bundled `/_astro` assets and allowed remote images all get signed URLs through `<Image>` from `emdash/ui`, Astro's `<Image>` and `<Picture>`, and `getImage()`. Contributors and above (`media:upload`) need no signature. Everyone else gets `403` with code `IMAGE_SIGNATURE_INVALID` on an unsigned `/_image` request, and `503` with `IMAGE_SIGNING_UNAVAILABLE` when `EMDASH_IMAGE_SECRET` is unset and the database can't be reached. Signing needs the stock runtime image service; with a custom service, including one that an integration set up after EmDash installs, or Cloudflare's `compile` or `custom` image modes, EmDash logs a warning and leaves signing off, and it does the same, naming the installed `@astrojs/cloudflare` version, when it can't read the adapter's image mode.

#### Before you enable it

- **Hand-written `/_image` URLs break** for visitors and Subscribers, for every source. Build them with `getImage()`. Subscribers' media library thumbnails also get `403` and fall back to full originals. Do not render an image at a size taken from the request, such as a query parameter: EmDash signs whatever size the page asks for.
- **Cloudflare prerendered pages need a build secret** under the default image mode (`imageService` unset) and `"cloudflare-binding"`. List `EMDASH_IMAGE_SECRET` under `secrets.required` in your Wrangler config (and under each named environment, which does not inherit it), export it when you build, and set the same value as a Worker secret. Without it the build fails with an error naming `EMDASH_IMAGE_SECRET` and where to set it. A secret set at build but missing or different at runtime makes prerendered images answer `403`, with no warning at build. `imageService: { build: "cloudflare-binding" }` and other builds need no secret. A `getImage()` call with no request context, for example in `getStaticPaths`, signs with the first `EMDASH_IMAGE_SECRET` value when it is set and otherwise ships an unsigned URL; set the variable, or call `getImage()` from the page.
- **Cached pages hold unsigned URLs.** Enable with a full deploy, not a gradual one. Under Workers Cache's default configuration no purge is needed. With `cache.cross_version_cache: true`, or another route cache whose entries outlive a deploy, purge after deploying, for example `ctx.cache.purge({ purgeEverything: true })`.

`EMDASH_IMAGE_SECRET` is a comma-separated list: the first value signs and every value verifies, so you can rotate. Without it, EmDash generates a secret on first use and stores it as the `emdash:image_secret` option, shared by every deployment on the same database. That row is created only when signing is on, and with `EMDASH_IMAGE_SECRET` set signing needs no database. Deployments with their own secrets must share the value. To rotate the stored secret, delete the option and redeploy, then purge cached pages.
