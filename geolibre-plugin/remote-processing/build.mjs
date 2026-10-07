// Bundles src/core.js and src/ui.js into dist/index.js. GeoLibre loads external plugins as a
// single ES module, so relative imports are inlined here. No dependencies needed.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const strip = (src) => src
  .replace(/^import[\s\S]*?from\s+["']\.\/core\.js["'];\s*$/m, "")
  .replace(/^export\s+(?=(async\s+)?(function|const|class|let)\b)/gm, "");

const core = strip(readFileSync("src/core.js", "utf8"));
const ui = readFileSync("src/ui.js", "utf8").replace(/^import[\s\S]*?from\s+["']\.\/core\.js["'];\s*$/m, "");
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.js", `// Remote Processing plugin for GeoLibre. Built from src/ by build.mjs, do not edit.\n${core}\n${ui}`);

if (process.argv.includes("--zip")) {
  rmSync("remote-processing.zip", { force: true });
  execFileSync("zip", ["-qr", "remote-processing.zip", "plugin.json", "dist"]);
  console.log("wrote remote-processing.zip");
}
console.log("wrote dist/index.js");
