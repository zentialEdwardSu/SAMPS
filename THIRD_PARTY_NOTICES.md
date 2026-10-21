# Third-party components

- **ONNX Runtime 1.24.4 (DirectML execution provider)**: Microsoft, MIT License.
  https://github.com/microsoft/onnxruntime
  Distributed as the NuGet package `Microsoft.ML.OnnxRuntime.DirectML`.
  `onnxruntime.dll` is renamed to `samps_onnxruntime.dll` and loaded by explicit
  path (see `native/src/runtime.cpp`) so it never collides with Photoshop's own
  bundled ONNX Runtime copy.
- **DirectML 1.15.4**: Microsoft, MIT License.
  https://github.com/microsoft/DirectML
  Distributed as the NuGet package `Microsoft.AI.DirectML`.
- **nlohmann/json 3.12.0**: Niels Lohmann, MIT License.
  https://github.com/nlohmann/json
- **Adobe UXP Hybrid Plugin SDK**: Adobe, governed by Adobe's accompanying SDK
  license. SDK headers are external build dependencies, not included in this
  source tree or the plugin package. The local development binary was compiled
  against the Adobe headers/utilities present in the public Bolt UXP starter:
  https://github.com/hyperbrew/bolt-uxp/tree/master/src/hybrid
  For rebuilding, use your own SDK obtained from Adobe Developer Console.
- **React 19 / Vite / Vitest**: used to build the UXP panel (`plugin-src/`);
  see `plugin-src/package.json` for exact versions and licenses (MIT).

## Models

Model weights and their ONNX export tooling are not part of this repository.
They are produced in the separate
[model-pipeline](../samps-model-pipeline) repository and published
independently (ModelScope/Hugging Face) — see that repository's own
`THIRD_PARTY_NOTICES.md` for the Ultralytics YOLOE-26 (AGPL-3.0) and Meta
SAM 3.1 (SAM License) terms that apply to the model packages this plugin
loads at runtime.

Python, PyTorch, and the model export/conversion tooling are not runtime
dependencies of this plugin.
