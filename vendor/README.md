# Vendored dependencies

## ironcalc

A copy of IronCalc `main` with the three collaboration PRs merged on top:

| | commit |
|---|---|
| `main` (ironcalc/IronCalc) | `9cfbdfce` |
| [#1477](https://github.com/ironcalc/IronCalc/pull/1477) Collab 1/3: Position trait | `c7515512` |
| [#1478](https://github.com/ironcalc/IronCalc/pull/1478) Collab 2/3: fractional index | `4b464bc5` |
| [#1479](https://github.com/ironcalc/IronCalc/pull/1479) Collab 3/3: stable model variant | `ec7eda8f` |

The merge is `fa64db0b`, made locally; it is not published anywhere. To
reproduce it, merge the three PR branches of
[Horusiath/IronCalc](https://github.com/Horusiath/IronCalc)
(`collab-1-position`, `collab-2-fractional-index`, `collab-3-stable`) into
`main` at the commit above, in that order. The copy was taken with
`git archive`, so it holds the tracked files and nothing else.

The PRs give IronCalc a collaborative model, `CollabModel`, whose edits
converge when made concurrently on several devices. The app syncs through it;
see [docs/collab-branch.md](../docs/collab-branch.md) for how it fits webxdc.
The same branch carries its own version of the canvas repaint fix that the
previous copy took from #1146 (the `revision` prop).

See [Building](../README.md#building) for how to build it.

### Local modifications

Three modifications were made. The first two are consequences of IronCalc
living inside another git repo, the third of a check in the build scripts.

`bindings/wasm/Makefile`, two changes:

- `pnpm exec tsc` gained `--ignoreConfig`.

  TypeScript walks up the directory parent chain and finds our own
  tsconfig.json, which breaks the build.

- `SRC_HASH` passes absolute paths to `git hash-object`. That command resolves
  relative paths against the repository root, which here is the calc project
  rather than `vendor/ironcalc`, so every path missed its file.

`bindings/wasm/src/lib.rs`:

- One doc comment says "like every other edit" instead of "like any other
  edit". `fix_types.py` rejects any line of the generated `wasm.d.ts` that
  contains the substring "any" - meant to catch untyped bindings - so
  upstream's `make collab` stops before it adds the types from `types.ts`.

Once the collaboration PRs are merged and released upstream, this directory
can be replaced by ordinary npm dependencies.
