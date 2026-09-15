# trace-ui-toolkit

The package provides application-independent trace viewer UI components: window geometry, a frame scheduler, a lane layout tree with a layout engine and reducers, and UI controls for panes, splitters, and virtualized lists.

Toolkit components operate independently of trace data formats. A lane specifies its type with a string ID and carries an opaque `source` property interpreted by the application.

## Dependency rule

Modules under `trace-ui-toolkit/` must not import from `web/core/`, `web/ui/`, or `src/`. Dependencies point in one direction:

```
web/app.ts, web/core/**, web/ui/**   →   web/trace-ui-toolkit/**
```

Checked with:

```sh
# Verify all relative imports stay within the package and contain no external imports
grep -rn --include='*.ts' -o 'from "[^"]*"' web/trace-ui-toolkit | grep -v 'from "\./' | grep -v 'from "\.\./layout-store.js"'
```

An import that references files outside the package directory, or references `web/core/`, `web/ui/`, or `src/`, violates this rule.

When a module requires application-specific configuration, the application supplies it through parameters, callbacks, or initialization functions. The `layout-store.ts` module implements this pattern: panes and splitters persist state to `localStorage` under a storage key supplied by the application at startup via `configureLayoutStorage`.

## Application responsibilities

### Lane rendering

The application implements the lane-type registry (`web/core/lanes/registry.ts`) and lane renderers typed against its own trace data model.

### Lane source interpretation

The application implements projections that interpret a lane's `source` property. For example, `contextLanes` in `web/core/lanes/selectors.ts` interprets `TimespanSource`. Projections that only inspect tree structure, such as `anyHidden` and `hiddenLaneCount`, are implemented in this package.

### Coordinate formatting

`TimeScale` maps numeric domain coordinates to pixel coordinates independently of time units. Member names default to seconds, but callers can supply values in any consistent numerical unit.
