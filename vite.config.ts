import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import { buildXDC, mockWebxdc } from "@webxdc/vite-plugins";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    svgr(),
    buildXDC({ outFileName: "calc.xdc" }),
    mockWebxdc(),
  ],
  optimizeDeps: {
    // `@ironcalc/workbook` is a linked package we actively rebuild. We
    // do not want vite to put it in a stale cache during its optimization.
    //
    // Once we can rely on a released version of IronCalc again, this can
    // be removed.
    exclude: ["@ironcalc/workbook"],
    // Being excluded, the library is not scanned, so the dependencies it
    // imports would only be discovered when the first page loads it. Vite then
    // re-optimizes and reloads every open page, which pulls pages out from
    // under the tests running in parallel. Pre-bundle them at startup instead.
    include: ["lucide-react", "i18next", "react-i18next"],
  },
  resolve: {
    // We end up with multiple copies of these dependencies due to the
    // vendored `@ironcalc/workbook`, and React doesn't like that, so we dedupe them.
    //
    // Once we can rely on a released version of IronCalc again, this can be removed.
    dedupe: ["react", "react-dom"],
  },
});
