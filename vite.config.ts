/**
 * Vite config for the trace viewer (`web/`).
 *
 * Two small wrinkles handled by plugins:
 * 1. The `src/trace` parser uses explicit `.js` import specifiers (TypeScript
 *    `moduleResolution: Bundler`). `jsToTs` resolves those to the sibling `.ts`
 *    source so the viewer can import the parser directly.
 * 2. The committed `.svdat` fixtures live under `test/fixtures/`. `serveFixtures`
 *    exposes them at `/fixtures/...` in dev so the app (and Playwright) can fetch
 *    them without copying binaries into the web root.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

const repoRoot = dirname(fileURLToPath(import.meta.url));

/** Resolve `./foo.js` to `./foo.ts` when only the `.ts` exists. */
function jsToTs(): Plugin {
  return {
    name: "trace-viewer:js-to-ts",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!importer || !source.startsWith(".") || extname(source) !== ".js") return null;
      const asTs = resolve(dirname(importer), source.slice(0, -3) + ".ts");
      return existsSync(asTs) ? asTs : null;
    },
  };
}

/** Serve `test/fixtures/traces/*.svdat` at `/fixtures/traces/...` in dev. */
function serveFixtures(): Plugin {
  return {
    name: "trace-viewer:serve-fixtures",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/fixtures/")) return next();
        const path = resolve(repoRoot, "test", decodeURIComponent(req.url.replace(/^\/fixtures\//, "fixtures/")));
        if (!path.startsWith(resolve(repoRoot, "test", "fixtures")) || !existsSync(path)) {
          res.statusCode = 404;
          return res.end("not found");
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(readFileSync(path));
      });
    },
  };
}

export default defineConfig({
  root: resolve(repoRoot, "web"),
  // Relative base so the built app works under any path prefix — in particular
  // the project subpath GitLab/GitHub Pages serves it from, where
  // the default absolute `/assets/...` references would 404. The dev server
  // and Playwright are unaffected (Vite serves dev from `/` regardless).
  base: "./",
  plugins: [jsToTs(), serveFixtures()],
  server: {
    port: 5180,
    fs: { allow: [repoRoot] },
    // Vite rejects requests whose Host header isn't localhost (DNS-rebinding
    // protection). A reverse-proxied preview (e.g. devbox-3001.igrr.me →
    // localhost:3001) needs its public hostname allowed explicitly:
    //   TRACE_VIEWER_ALLOWED_HOSTS=devbox-3001.igrr.me npm run dev -- --port 3001
    allowedHosts: process.env["TRACE_VIEWER_ALLOWED_HOSTS"]?.split(",") ?? [],
  },
  build: { outDir: resolve(repoRoot, "dist/web"), emptyOutDir: true },
});
