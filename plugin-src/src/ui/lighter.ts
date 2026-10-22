import { MODELS, type ModelChoice } from "./models";

/** Errors that mean the GPU ran out of memory or was reset (often after running out). */
export const isGpuFailure = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code;
  return code === "GPU_MEMORY" || code === "GPU_LOST";
};

// Ordered from heaviest to lightest by measured VRAM on the GPU path.
const ORDER = ["sam3", "sam3-840", "sam3-672", "yoloe26x"];

/**
 * The next lighter model for a GPU memory failure, or null when nothing lighter is left.
 * Without the encoder-release option on, turning it on comes first: it keeps the same model.
 */
export function lighterOption(modelId: string, releaseEncoder: boolean):
  { kind: "release" } | { kind: "model"; model: ModelChoice } | null {
  const index = ORDER.indexOf(modelId);
  if (index < 0) return null;
  if (!releaseEncoder && modelId.startsWith("sam3")) return { kind: "release" };
  const next = ORDER[index + 1];
  const model = next ? MODELS.find(item => item.id === next) : undefined;
  return model ? { kind: "model", model } : null;
}

/** Status text for a GPU memory failure while `stage` ("加载模型" / "识别"). */
export function gpuFailureText(error: unknown, stage: string, option: ReturnType<typeof lighterOption>): string {
  const lost = (error as { code?: string }).code === "GPU_LOST";
  const cause = lost ? `${stage}时显卡驱动重置（通常是显存耗尽），模型已卸载。` : `${stage}时显存不足。`;
  if (!option) return `${cause}已是最轻量的模型，请关闭占用显存的程序后重试，或改用 CPU。`;
  if (option.kind === "release") return `${cause}可勾选“编码后释放编码器显存”，或换用更轻量的模型。`;
  return `${cause}请换用更轻量的模型：${option.model.label}。`;
}
