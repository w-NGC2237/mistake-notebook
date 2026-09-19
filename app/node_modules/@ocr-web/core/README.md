# @ocr-web/core

PP-OCR 推理引擎核心包，面向浏览器/Electron。

- 推理：[`onnxruntime-web`](https://onnxruntime.ai/docs/tutorials/web/)（peer dep）
- 几何：纯 JS 实现（连通域 + 凸包 + minAreaRect + perspective warp），不依赖 opencv-js
- 字典：CTC greedy decode，PaddleOCR 约定（blank=idx0，末尾追加空格）
- 体积：~20KB ESM（不含 ort-web）

## 安装

```bash
pnpm add @ocr-web/core onnxruntime-web @ocr-web/models-ppocrv5
```

`onnxruntime-web` 的 `*.wasm` 文件需要被你的构建工具拷贝到一个可访问的路径（如 `/ort/`）。
Vite 用法：

```ts
// vite.config.ts
import { viteStaticCopy } from "vite-plugin-static-copy";
export default {
  plugins: [
    viteStaticCopy({
      targets: [
        { src: "node_modules/onnxruntime-web/dist/*.wasm", dest: "ort" },
        { src: "node_modules/onnxruntime-web/dist/*.mjs", dest: "ort" },
      ],
    }),
  ],
  optimizeDeps: { exclude: ["onnxruntime-web"] },
};
```

## API

### `OcrEngine.create(opts)`

```ts
interface OcrEngineOptions {
  models: {
    detection: string | ArrayBuffer | Uint8Array;
    recognition: string | ArrayBuffer | Uint8Array;
    classification?: string | ArrayBuffer | Uint8Array; // 保留接口；PP-OCRv5 未发布 cls
  };
  dictionary: string | string[]; // URL / 完整字典文本 / 字符数组
  runtime?: "wasm" | "webgpu";   // 默认 "wasm"
  wasmPaths?: string | Record<string, string>;
  numThreads?: number;            // 默认 1
}
```

### `engine.recognize(input, opts?)`

```ts
type ImageInput =
  | HTMLCanvasElement
  | OffscreenCanvas
  | ImageData
  | ImageBitmap
  | Blob
  | string; // URL

interface RecognizeOptions {
  detThreshold?: number;     // 默认 0.3 — 检测概率二值化阈值
  detBoxThreshold?: number;  // 默认 0.6 — 框平均概率过滤阈值
  maxSideLen?: number;       // 默认 960 — det 输入最长边
  unclipRatio?: number;      // 默认 1.6 — 框扩张系数
  minBoxSize?: number;       // 默认 3 像素
}

interface OcrLine {
  text: string;
  box: [Point, Point, Point, Point]; // TL, TR, BR, BL
  confidence: number;
}

interface OcrResult {
  lines: OcrLine[];
  fullText: string;
  durationMs: number;
}
```

### `engine.dispose()`

释放底层 ort session。

## 调参经验

- **小字号识别差**：把 `detThreshold` 调到 0.2，`unclipRatio` 调到 1.8-2.0
- **检测漏框**：降 `detThreshold`（0.2-0.25）
- **检测框相互粘连**：升 `detThreshold`（0.4-0.5）
- **框过紧导致 rec 错字**：升 `unclipRatio` 到 1.8-2.0

## 性能（M2 Mac, WASM 单线程）

| 场景 | 时长 |
|---|---|
| 引擎初始化（含模型加载） | ~500-700ms |
| det 推理（单页 A4） | ~250ms |
| rec 推理（单行） | ~50-100ms |
| 端到端 4 行简单图 | ~450ms |
| 端到端 13 行复杂图 | ~1.4s |

## 实现说明

DBNet 后处理走的是 PaddleOCR 等价路线，但用纯 JS 复现：

1. det 输出 sigmoid 概率图 `[1,1,H,W]`
2. 阈值二值化
3. 8 邻接 BFS 连通域 → 像素点集
4. 凸包（Andrew's monotone chain） → minAreaRect（rotating calipers）
5. unclip：`distance = area * ratio / perimeter`，按距离向外扩
6. 评分过滤（区域内平均概率 < `detBoxThreshold` 则丢弃）
7. perspective warp 到 32×W 喂 rec
8. CTC greedy decode

License: MIT
