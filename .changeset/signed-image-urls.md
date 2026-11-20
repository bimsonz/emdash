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

With signing on, stored media, bundled `/_astro` assets and allowed remote images all get signed URLs through `<Image>` from `emdash/ui`, Astro's `<Image>` and `<Picture>`, and `getImage()`. Contributors and above (`media:upload`) need no signature. Everyone else gets `403` with code `IMAGE_SIGNATURE_INVALID` on an unsigned `/_image` request, and `503` with `IMAGE_SIGNING_UNAVAILABLE` if the secret cannot be resolved. Signing needs the stock runtime image service; with a custom service, or Cloudflare's `compile` or `custom` image modes, EmDash logs a warning and leaves signing off.

#### Before you enable it

- **Hand-written `/_image` URLs break** for visitors and Subscribers, for every source. Build them with `getImage()`. Subscribers' media library thumbnails also get `403` and fall back to full originals. Do not render an image at a size taken from the request, such as a query parameter: EmDash signs whatever size the page asks for.
- **Cloudflare prerendered pages need a build secret** under the default `cloudflare-binding` image mode. List `EMDASH_IMAGE_SECRET` under `secrets.required` in your Wrangler config, export it when you build, and set the same value as a Worker secret. Without it the build fails with `ImageSigningSecretRequiredError`. Other builds need no secret. A `getImage()` call outside the page render during a prerender, for example in `getStaticPaths`, ships an unsigned URL; call it from the page.
- **Cached pages hold unsigned URLs.** Enable with a full deploy, not a gradual one. Under Workers Cache's default configuration no purge is needed. With `cache.cross_version_cache: true`, or another route cache whose entries outlive a deploy, purge after deploying, for example `ctx.cache.purge({ purgeEverything: true })`.

`EMDASH_IMAGE_SECRET` is a comma-separated list: the first value signs and every value verifies, so you can rotate. Without it, EmDash generates a secret on first use and stores it as the `emdash:image_secret` option, shared by every deployment on the same database. Deployments with their own secrets must share the value. To rotate the stored secret, delete the option and redeploy, then purge cached pages.
