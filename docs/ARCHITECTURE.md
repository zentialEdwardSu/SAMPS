# 推理架构

## 入口：UXP Hybrid + ONNX Runtime

`plugin-src/public/manifest.json` 注册 UXP 停靠面板，构建产物在 `dist/`。
面板（React，`plugin-src/src/ui/App.tsx`）通过 `await require("samps-0.5.0.uxpaddon")`
加载 Windows x64 原生模块（`native/src/addon.cpp`）。JavaScript 侧
（`plugin-src/src/host/PhotoshopHost.ts`）用 Photoshop Imaging API 和 DOM 管理画布、
图层、选区及历史事务；C++ addon 在工作线程用 ONNX Runtime + DirectML/CPU 执行推理。

模型按 `model.json`（见下文"模型包契约"）动态加载，当前支持两种架构：
- **YOLOE-26x**：视觉提示分割，涂抹目标区域即可，无类别概念。
- **SAM 3.1（仅视觉部分）**：概念分割 + 交互式修边，支持"添加/排除"笔刷和自动合并
  配饰（背包、帽子等）到当前对象。仅支持 DirectML GPU（`requiresGpu: true`）。

推理期间面板保持非模态；读写文档时短暂进入 `executeAsModal`。
`entrypoints.setup` 注册必需的 `plugin.create()` 和卸载处理；模型初始化由
`create()` 异步启动，避免阻塞生命周期。启动错误同时显示在模型区和状态区。
原生模块加载返回 Promise；完成后校验 `submit / take / cancel`，再允许模型初始化。
模块加载期间卸载插件会阻止迟到的初始化。

`tools/build.ps1` 和 CMake 默认构建 Hybrid；`tools/stage_models.py` 把已验证的
ONNX 模型包（发布在 ModelScope/Hugging Face，或通过 `--models-root` 指向本地
构建的目录）复制进 `dist/models/`。

```text
Photoshop Imaging API → RGBA / add-prompt alpha / exclude alpha → UXP addon worker
                                               │
          ONNX image graph: backbone + neck (+ SAM3 interactive neck)
                                               │ cached CPU-accessible tensors
          ONNX prompt graph: 提示编码 + 候选评分/框/掩码
                                               │
          C++ 后处理：YOLOE 的 masked softmax/对比相似度，或 SAM3 的框去重 + NMS
                    → 当前模式下跨实例合并 → 可选 SAM3 interactive refine 微调边缘
                    → 洞/孤岛清理 → 裁剪文档坐标掩码
                                               │
                  UXP → 半透明红色预览 → 用户确认 → 选区（新建/加/减/交）或蒙版图层
```

## 模型包契约（`model.json`）

`Engine::initialize`（`native/src/engine.cpp`）从一个目录加载模型包，要求：
- `runtime` 必须是 `"onnxruntime"`。
- `architecture` 决定分派到哪个实现：`"yoloe26-visual-split-onnx-v1"` →
  `native/src/yoloe26.cpp`；`"sam3.1-exemplar"` → `native/src/sam3.cpp`。
- `files`：相对文件名 → SHA256，禁止子目录/绝对路径；加载前逐一校验。
- `graphs`：图名（`"image"`、`"prompt"`，SAM3 额外有 `"refine"`）→ `files` 中的文件名。
- `validation.passed`：未通过且未显式允许试用时拒绝加载。
- `requiresGpu`：为真时拒绝 CPU 回退，初始化失败直接报错而非降级。

这是模型流水线仓库（`tools/export_model.py`、`tools/export_sam3.py`）和
本仓库 `tools/stage_models.py` 共同遵守的接口；改动需要两边同步。

## 设备、内存及生命周期

ONNX Runtime 按设备偏好自动选择 DirectML GPU，失败时退回 CPU 并报告实际后端
（除非模型包要求 `requiresGpu`）。权重加载前校验所有图文件 SHA256。

UXP 层的 `initialize / prepareImage / segment / cancel / dispose` 是异步包装。
底层 `submit / take / cancel` 采用一个 C++ worker，JS 每 40ms 获取完成状态。
worker 不保留任何 JavaScript 句柄，也不调用 Photoshop API。
取消是协作式的，已在执行的单次推理会运行到检查点，然后丢弃结果。
addon 卸载时等待 worker 结束，避免悬空回调。

最多缓存一个图像 session；下一次准备图像或重新初始化释放旧 session。
内存中的原图和掩码不写临时文件、不上传。

## Photoshop 事务

读取画面交给 Photoshop 原生色彩引擎处理（不再按文件名特判 PSD、不创建临时文档）。
读取提示及画面在短 modal 内完成，所有插件托管图层（标记组、结果、预览）临时隐藏。
显式恢复图层可见性，并在需要隐藏插件图层时用 `suspendHistory / resumeHistory(..., true)`
合并临时操作。读取完成后记录提交后的 history ID。推理在 modal 外执行。
输出前及获得 modal 锁后均检查文档 ID、尺寸、history state ID。
所有新图层/选区/蒙版合为一个历史事务，错误时回滚。

按图层名前缀（`[SAMPS 标记]`、`[SAMPS 结果]`、`[SAMPS 预览]`）管理托管图层；
原生 worker 内为单任务串行。详见 `plugin-src/src/host/PhotoshopHost.ts`。
