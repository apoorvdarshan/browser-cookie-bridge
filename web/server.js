import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const requestedPort = Number.parseInt(process.env.PORT || process.argv[2] || "3000", 10);
const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 3000;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
};

const routeFiles = new Map([
  ["/", "index.html"],
  ["/privacy", "privacy.html"],
  ["/terms", "terms.html"],
]);

function resolveRequestPath(urlPath) {
  const route = routeFiles.get(urlPath);
  const relativePath = route || normalize(decodeURIComponent(urlPath)).replace(/^[/\\]+/, "");
  const candidate = resolve(join(root, relativePath));
  if (candidate !== root && !candidate.startsWith(`${root}/`)) return null;
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return null;
  return candidate;
}

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  const filePath = resolveRequestPath(url.pathname);

  if (!filePath) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }

  response.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Browser Cookie Bridge website: http://localhost:${port}`);
});
