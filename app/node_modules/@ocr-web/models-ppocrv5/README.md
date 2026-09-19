# @ocr-web/models-ppocrv5

PP-OCRv5 mobile 模型 URL（det + rec + dict），托管在仓库 git 中通过 jsDelivr CDN 分发（自带 CORS、全球加速、文件级缓存）。

## 用法

```ts
import { OcrEngine } from "@ocr-web/core";
import { ppocrV5 } from "@ocr-web/models-ppocrv5";

const engine = await OcrEngine.create({
  models: {
    detection: ppocrV5.detection,
    recognition: ppocrV5.recognition,
  },
  dictionary: ppocrV5.dictionary,
});
```

## 模型规格

| 文件 | 大小 | 说明 |
|---|---|---|
| `ppocrv5_det.onnx` | 4.6MB | 文本检测，input `[1,3,H,W]` H,W∈32倍数 max=960，output `[1,1,H,W]` 含 sigmoid |
| `ppocrv5_rec.onnx` | 16MB | 文本识别，input `[N,3,32,W]`，output `[N,T,18385]` |
| `ppocrv5_dict.txt` | 72KB | 多语言字典 18383 行 + 末尾空格 = 18384 字符 |

## 注意

- **PP-OCRv5 没有发布独立的 cls 模型**。如果需要方向分类（处理上下颠倒的图），自己提供一个 `cls` ONNX。
- v5 rec 输入高度为 **32**（v4 是 48）。core 内部已处理。
- 字典支持中、英、日、韩、繁体中文、emoji 等。

License: Apache-2.0（继承自 PaddleOCR）
