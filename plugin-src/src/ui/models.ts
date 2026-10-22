export interface ModelChoice {
  id: string;
  label: string;
  /** Folder name under the plugin's models/ directory. */
  folder: string;
  hint: string;
  /** Refuses the CPU provider (see the bundle's "requiresGpu"). */
  gpuOnly?: boolean;
  /**
   * Model input size. SAM 3 quality levels are input-size variants of one bundle that share its
   * weights; 0 or absent loads the bundle's native size.
   */
  inputSize?: number;
}

const SAM3_HINT = "橙色涂对象和配饰，蓝色涂不要的部分。当前=合并成一个对象，相似=同一概念的全部实例。";

export const MODELS: ModelChoice[] = [
  { id: "sam3", label: "SAM 3.1 · 1008 px", folder: "sam3", gpuOnly: true, inputSize: 1008,
    hint: `${SAM3_HINT} 边缘最细，显存最多。` },
  { id: "sam3-840", label: "SAM 3.1 · 840 px", folder: "sam3", gpuOnly: true, inputSize: 840,
    hint: `${SAM3_HINT} 显存约为 1008 px 的六成。` },
  { id: "sam3-672", label: "SAM 3.1 · 672 px", folder: "sam3", gpuOnly: true, inputSize: 672,
    hint: `${SAM3_HINT} 显存最少、最快；小物体和细边缘较粗。` },
  { id: "yoloe26x", label: "YOLOE-26x · 快速", folder: "yoloe26x",
    hint: "橙色涂目标的代表性区域，速度最快；蓝色涂到的像素会被去掉。" }
];

export const modelById = (id: string) => MODELS.find(item => item.id === id) || MODELS[0];
