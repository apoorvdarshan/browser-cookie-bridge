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

## Pages

- `index.html` — product landing page and documentation overview
- `privacy.html` — privacy policy
- `terms.html` — terms of use

## Assets

The browser logos are copies of the app's bundled browser assets. The product UI images come from `marketing/`. `hero-transfer.webp` was generated specifically for the website with OpenAI's built-in image-generation tool.
