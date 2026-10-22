export class SampsError extends Error {
  code: string;
  prompt?: unknown;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export const messages: Record<string, string> = {
  EMPTY_PROMPT: "标记在缩小后过于细小，请扩大涂抹范围后重试。",
  MODEL_UNVALIDATED: "该模型尚未通过原生一致性验证，请使用已验证的模型包。",
  MODEL_MISSING: "模型文件不完整，请选择包含 model.json 的模型目录。",
  MODEL_HASH: "模型校验失败，请重新复制完整的模型包。",
  CANCELLED: "任务已取消。",
  STALE_SESSION: "图像缓存已失效，请重新识别。",
  GPU_MEMORY: "显存不足，请换用更轻量的模型。",
  GPU_LOST: "显卡驱动已重置（通常是显存耗尽），请换用更轻量的模型后重新加载。"
};

export function describe(error: unknown): string {
  const item = error as { code?: string; message?: string };
  return (item && item.code && messages[item.code]) || (item && item.message) || String(error);
}
