import { SampsError } from "../core/errors";

export interface Addon {
  submit(operation: string, json: string, buffer: ArrayBuffer): number;
  take(id: number): { json: string; buffer: ArrayBuffer } | null;
  cancel(id: number): void;
}
export interface ModelInfo {
  modelName: string; deviceName: string; precision: string; validationPassed?: boolean;
  architecture?: string; promptKind?: string;
}
export interface Instance {
  id: number; left: number; top: number; width: number; height: number;
  confidence: number; label?: string; parts?: number; refined?: boolean; detailed?: boolean; offset: number; length: number; mask: Uint8Array;
}
export type PromptDiagnostics = Record<string, any> & { transferMatches?: boolean };

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function fnv1a(bytes: Uint8Array) {
  let checksum = 2166136261, painted = 0;
  for (let i = 0; i < bytes.length; i++) {
    checksum = Math.imul(checksum ^ bytes[i], 16777619) >>> 0;
    if (bytes[i]) painted++;
  }
  return { checksum, painted };
}

export class NativeEngine {
  private requestId: number | null = null;
  private cancelled = false;
  lastPromptDiagnostics: PromptDiagnostics | null = null;

  constructor(private addon: Addon, private delay: (ms: number) => Promise<void> = sleep) {
    const missing = ["submit", "take", "cancel"].filter(name => !addon || typeof (addon as any)[name] !== "function");
    if (missing.length) {
      throw new SampsError("ADDON_API", `原生模块接口不完整（缺少 ${missing.join(" / ")}），请重新加载完整的 Hybrid 插件。`);
    }
  }

  get busy() { return this.requestId !== null; }

  async request(operation: string, options: object, bytes: Uint8Array = new Uint8Array(0)) {
    if (this.requestId !== null) throw new SampsError("BUSY", "请等待当前任务结束。");
    const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer as ArrayBuffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const id = this.addon.submit(operation, JSON.stringify(options), buffer);
    this.requestId = id; this.cancelled = false;
    try {
      for (;;) {
        const response = this.addon.take(id);
        if (response !== null) {
          const result = JSON.parse(response.json);
          if (this.cancelled) throw new SampsError("CANCELLED", "任务已取消。");
          if (!result.ok) {
            const error = new SampsError(result.code, result.message);
            error.prompt = result.prompt;
            throw error;
          }
          return { value: result.value, bytes: new Uint8Array(response.buffer) };
        }
        await this.delay(40);
      }
    } finally { this.requestId = null; }
  }

  async initialize(directory: string, device = -2, allowUnvalidated = false): Promise<ModelInfo> {
    // Non-finite UI values serialize to JSON null, which C++ cannot read as an int.
    const safeDevice = Number.isInteger(device) && device >= -2 ? device : -2;
    return (await this.request("initialize", { directory, device: safeDevice, allowUnvalidated })).value;
  }

  async prepareImage(bytes: Uint8Array, geometry: { width: number; height: number }):
    Promise<{ sessionId: number; info: ModelInfo }> {
    return (await this.request("prepareImage", geometry, bytes)).value;
  }

  /**
   * `prompt` is the add-stroke alpha; `exclude`, when given, is sent as a second plane of the same
   * size. The transfer check covers the add plane, which every model uses.
   */
  async segment(sessionId: number, prompt: Uint8Array, options: { confidence: number; mode: string; detail?: boolean },
    exclude: Uint8Array | null = null): Promise<Instance[]> {
    if (exclude && exclude.length !== prompt.length) throw new SampsError("BUFFER_SIZE", "排除图层与提示图层尺寸不一致。");
    const { checksum, painted } = fnv1a(prompt);
    const sent = { sentBytes: prompt.byteLength, sentPaintedPixels: painted, sentChecksum: checksum };
    this.lastPromptDiagnostics = sent;
    const record = (native: any) => {
      this.lastPromptDiagnostics = { ...sent, ...native, transferMatches: Boolean(native &&
        native.sourceBytes === prompt.byteLength && native.sourcePaintedPixels === painted && native.alphaChecksum === checksum) };
    };
    let result;
    let payload = prompt;
    if (exclude) { payload = new Uint8Array(prompt.length * 2); payload.set(prompt); payload.set(exclude, prompt.length); }
    try { result = await this.request("segment", { sessionId, ...options, hasNegative: Boolean(exclude) }, payload); }
    catch (error: any) { if (error.prompt) record(error.prompt); throw error; }
    record(result.value.prompt);
    if (!this.lastPromptDiagnostics!.transferMatches) {
      throw new SampsError("PROMPT_TRANSFER", "提示像素的 JS / C++ 校验不一致，已停止输出。");
    }
    return result.value.instances.map((item: Instance) => {
      if (item.offset < 0 || item.length !== item.width * item.height || item.offset + item.length > result.bytes.length) {
        throw new SampsError("MASK_BUFFER", "原生模块返回了无效蒙版。");
      }
      return { ...item, mask: result.bytes.subarray(item.offset, item.offset + item.length) };
    });
  }

  cancel() {
    this.cancelled = true;
    if (this.requestId !== null) this.addon.cancel(this.requestId);
  }

  async dispose(sessionId: number) { await this.request("dispose", { sessionId }); }
}
