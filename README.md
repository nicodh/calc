# IronCalc Webxdc
![image](https://github.com/user-attachments/assets/062d2ac0-33b5-46ba-a96c-9698e56ba424)

Bundle the [ironcal](https://github.com/ironcalc/ironcalc) frontend as webxdc application.

## Syncing
You can sync your sheets with other group members. 


## Building

Syncing uses IronCalc's collaborative model, which is still in review
upstream (PRs #1477-#1479). For the time being we depend on a vendored IronCalc
in `vendor/ironcalc` with those PRs merged (see
[vendor/README.md](vendor/README.md)).

It needs to build before we can create the .xdc app.
All paths are relative to the root of this project.

### Build the IronCalc wasm library

You first need `wasm-pack`, a Rust toolchain and `python`. It produces
`@ironcalc/wasm`:

```bash
cd vendor/ironcalc/bindings/wasm
make collab
```

`make collab` builds the collaborative model, with xlsx support, into `pkg/`.

### Build the IronCalc JS UI library

This needs `npm`. It produces `@ironcalc/workbook`, and uses the
`@ironcalc/wasm` built above:

```bash
cd vendor/ironcalc/webapp/IronCalc
npm install
npm run build
```

### Build the webxdc

This links against both libraries built above:

```bash
pnpm install
pnpm build
```

The webxdc will then be in the `dist-xdc` folder, as `calc.xdc`.

Later builds only need this last step, unless you change the vendored IronCalc.

## Developing with webxdc-dev

[webxdc-dev](https://github.com/webxdc/webxdc-dev) simulates multiple peers so you
can test syncing locally. Two workflows are available:

Run against the vite dev server (hot-reload, best for iterating):

```bash
pnpm dev:webxdc
```

Run against the actual built `.xdc` artifact (faithful to what ships):

```bash
pnpm webxdc:xdc
```

Both open the webxdc-dev frontend on `http://localhost:7000`. There is also
`pnpm webxdc:dist`, which runs against the unpacked `dist` directory.
