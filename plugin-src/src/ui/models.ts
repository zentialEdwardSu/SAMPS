export interface ModelChoice {
  id: string;
  label: string;
  /** Folder name under the plugin's models/ directory. */
  folder: string;
  hint: string;
  /** Refuses the CPU provider (see the bundle's "requiresGpu"). */
  gpuOnly?: boolean;
}

export const MODELS: ModelChoice[] = [
  { id: "sam3", label: "SAM 3.1 · 高质量", folder: "sam3", gpuOnly: true,
    hint: "橙色涂对象和配饰，蓝色涂不要的部分。当前=合并成一个对象，相似=同一概念的全部实例。" },
  { id: "yoloe26x", label: "YOLOE-26x · 快速", folder: "yoloe26x",
    hint: "橙色涂目标的代表性区域，速度最快；蓝色涂到的像素会被去掉。" }
];

export const modelById = (id: string) => MODELS.find(item => item.id === id) || MODELS[0];
