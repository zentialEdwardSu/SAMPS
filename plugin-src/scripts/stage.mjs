// Post-build: make Vite's output loadable by UXP and check the native files are in place.
// UXP does not execute <script type="module">, so the IIFE bundle is loaded as a classic script.
// CMake writes the addon and its ONNX Runtime/DirectML DLLs straight into dist/win/x64.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dist = path.join(root, "dist");
const html = path.join(dist, "index.html");

let text = fs.readFileSync(html, "utf8");
const script = /<script[^>]*src="\.\/index\.js"[^>]*><\/script>\s*/;
if (!script.test(text)) throw new Error("index.js script tag not found in dist/index.html");
text = text.replace(script, "").replace("</body>", '  <script src="index.js"></script>\n</body>');
fs.writeFileSync(html, text);

for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) fs.copyFileSync(path.join(root, name), path.join(dist, name));

const manifest = JSON.parse(fs.readFileSync(path.join(dist, "manifest.json"), "utf8"));
const native = path.join(dist, "win/x64");
const missing = [manifest.addon.name, "samps_onnxruntime.dll", "onnxruntime_providers_shared.dll", "DirectML.dll"]
  .filter(name => !fs.existsSync(path.join(native, name)));
const models = fs.existsSync(path.join(dist, "models")) ? fs.readdirSync(path.join(dist, "models")) : [];
console.log(`Staged ${dist}`);
if (missing.length) console.warn(`  native files not built yet: ${missing.join(", ")} (cmake --build build-hybrid-ort)`);
console.log(`  models: ${models.length ? models.join(", ") : "none (python tools/stage_models.py)"}`);
