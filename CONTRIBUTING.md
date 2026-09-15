# Contributing

## Development

Development requires Node.js 22 or newer.

```sh
npm install
npm run dev        # dev server on http://localhost:5180
npm run build      # production build into dist/web/
npm run preview    # serve the production build
```

The `web/trace-ui-toolkit/` directory holds app-agnostic UI primitives and enforces a one-way dependency rule: it must not import from `web/core/`, `web/ui/`, or `src/`. For details, see `web/trace-ui-toolkit/README.md`.

## Testing

```sh
npm run typecheck
npm run test:unit              # node --test suite (test/unit/)
npm run test:e2e               # Playwright, DOM assertions only off Linux
npm run test:e2e:docker        # full suite incl. screenshot baselines
npm run test:e2e:docker:update # regenerate those baselines
```

A pinned Linux container generates screenshot baselines to prevent drift caused by host font rasterization. Generate and compare screenshot baselines using the `:docker` scripts. To regenerate a baseline, delete the existing `.png` file first; `--update-snapshots` does not modify existing full-page screenshots.

## Generated sources

Two OS event tables are generated from description files in the ESP-IDF and Zephyr source trees, and must not be edited by hand:

```sh
npx tsx scripts/gen-freertos-events.ts > src/trace/os/freertos.ts
npx tsx scripts/gen-zephyr-events.ts > src/trace/os/zephyr.ts
```
