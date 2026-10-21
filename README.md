# SAMPS — Photoshop UXP Hybrid 视觉分割插件

Windows x64 / Photoshop 2026 **27.8+**，当前版本 **0.5.0**。
插件采用 **UXP 停靠面板（React）+ C++ `.uxpaddon` + ONNX Runtime（DirectML/CPU）**。
内置 **SAM 3.1**（高质量，仅 GPU，支持"添加/排除"笔刷和配饰合并）和
**YOLOE-26x**（快速，视觉提示）两个模型。

本仓库只包含插件本身；可用的 ONNX 模型包由独立的
[model-pipeline](../samps-model-pipeline) 仓库产出，通过 git submodule 引入
（见下方"获取模型"）。模型包格式契约见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 获取模型

```powershell
git submodule update --init
.\.venv\Scripts\python.exe tools\stage_models.py
```

这会把 `model-pipeline/models/{sam3.1-vision-fp16s,yoloe26x-onnx}` 下已验证的
ONNX 包复制进 `dist/models/`，供面板加载。

## 构建

需要 Visual Studio C++、Windows SDK、CMake，以及外部 Adobe UXP Hybrid SDK
（`UXP_SDK_ROOT`）。原生依赖（ONNX Runtime DirectML、DirectML、nlohmann/json）
固定版本，哈希见 `dependencies.lock.json`。

```powershell
.\.venv\Scripts\python.exe tools\fetch_native_deps.py
cmake -S . -B build-hybrid -A x64 -DUXP_SDK_ROOT="C:\path\to\uxp-hybrid-sdk"
cmake --build build-hybrid --config Release --target samps
cd plugin-src
npm install
npm run build
```

`npm run build` 会把面板（Vite）产物和原生 addon 一起整理进仓库根的 `dist/`
（`plugin-src/scripts/stage.mjs`）。`tools/build.ps1` 提供等价的一键 CMake 构建，
`-CoreOnly` 只构建不依赖 Hybrid SDK 的原生测试可执行文件：

```powershell
.\tools\build.ps1 -SdkRoot "C:\path\to\uxp-hybrid-sdk"
.\tools\build.ps1 -CoreOnly -BuildDirectory build-core
```

## 加载和使用

1. 打开 Photoshop，在"首选项 > 增效工具"中启用开发者模式，按提示重启。
2. 打开 UXP Developer Tool，点击 Add Plugin，选择本项目的 `dist/manifest.json`，然后 Load。
3. 在 Photoshop 的"增效工具 / Plugins"菜单打开"SAMPS 视觉分割"面板。
4. 选择模型（SAM 3.1 或 YOLOE-26x），等待离线模型加载。
5. 用添加画笔（橙色）涂抹目标对象及其配饰；需要时用排除画笔（蓝色）涂掉不要的部分。
6. 选择"当前对象"或"所有相似"，点击识别，画布上会显示红色半透明预览。
7. 勾选实例，生成选区（可设置扩张/羽化）或带蒙版的结果图层；输出可一次撤销。

面板支持拖动调整大小；画布上的标记组（添加/排除图层）和预览图层可随时用面板上的
眼睛按钮显示或隐藏。推理在 C++ 工作线程执行，设备默认优先 DirectML GPU，
SAM 3.1 不支持 CPU 回退。运行不依赖 Python、HTTP 服务或 CUDA。

## 测试

```powershell
cd plugin-src
npm run typecheck
npx vitest run
```

```powershell
.\tools\build.ps1 -CoreOnly -BuildDirectory build-core
ctest --test-dir build-core -C Release --output-on-failure
```

## 目录结构

- `plugin-src/`：React 面板（TypeScript + Vite），构建到仓库根 `dist/`。
- `native/src/`：原生引擎——`engine.cpp`（设备选择/校验/生命周期）、
  `runtime.cpp`（ONNX Runtime + DirectML 会话管理）、`yoloe26.cpp`/`sam3.cpp`
  （各模型的预处理/后处理）、`addon.cpp`（UXP 异步任务桥接）。
- `native/tests/`：`prompt.cpp`（CTest 几何测试）、`validation.cpp`/`behavior.cpp`
  （开发期对照/压力测试运行器，不随插件分发）。
- `docs/ARCHITECTURE.md`：当前架构、模型包契约。
- `model-pipeline/`：git submodule，指向模型流水线仓库（导出/转换/校验脚本见其
  `tools/`，不在本仓库）。
- `tools/`：原生构建辅助（`fetch_native_deps.py`、`build.ps1`）、
  打包校验（`verify_hybrid.py`）、模型分发（`stage_models.py`）、
  开发期调试（`cdp_eval.cjs`）。

项目代码采用 AGPL-3.0，依赖说明见 [第三方声明](THIRD_PARTY_NOTICES.md)。
