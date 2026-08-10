# Browser Cookie Bridge website

Static product website, documentation overview, privacy policy, and terms for Browser Cookie Bridge.

## Run locally

From the repository root:

```bash
npm run web
```

Then open [http://localhost:3000](http://localhost:3000).

Use another port when needed:

```bash
PORT=4173 npm run web
```

The site has no runtime dependencies, analytics, forms, or remote font requests. `server.js` uses Node's built-in HTTP server for local preview only; any static host can serve the contents of this folder.

## Deploy

The production site uses Cloudflare Workers Static Assets on `cookiebridge.apoorvdarshan.com`:

```bash
npm run web:deploy
```

Wrangler creates and manages only that Custom Domain. `.assetsignore` prevents the local server and project notes from being published as website assets.

## Pages

- `index.html` — product landing page and documentation overview
- `privacy.html` — privacy policy
- `terms.html` — terms of use

## Search metadata

- `sitemap.xml` lists the three canonical public pages.
- `robots.txt` allows public crawling and advertises the sitemap.
- Each page defines a canonical URL, search description, Open Graph and X card metadata, and JSON-LD structured data.

## Assets

The browser logos are copies of the app's bundled browser assets. The product UI images come from `marketing/`. `hero-transfer.webp` was generated specifically for the website with OpenAI's built-in image-generation tool.
