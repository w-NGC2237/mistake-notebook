import {
  OcrEngine,
  isRpcMessage,
  normalizeInput
} from "./chunk-5MGQAOZE.js";

// src/engine-worker.ts
var OcrEngineWorker = class _OcrEngineWorker {
  constructor(worker) {
    this.worker = worker;
    worker.addEventListener("message", (ev) => this.handle(ev));
  }
  worker;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  onProgress;
  static async create(opts) {
    const inst = new _OcrEngineWorker(opts.worker);
    inst.onProgress = opts.onProgress;
    const { worker: _w, onProgress: _p, ...payload } = opts;
    void _w;
    void _p;
    await inst.call("create", [payload]);
    return inst;
  }
  async recognize(input, opts) {
    const img = await normalizeInput(input);
    const buffer = img.data.buffer.slice(0);
    return await this.call(
      "recognize",
      [{ data: buffer, width: img.width, height: img.height }, opts],
      [buffer]
    );
  }
  async dispose() {
    try {
      await this.call("dispose", []);
    } finally {
      this.worker.terminate();
      for (const { reject } of this.pending.values()) reject(new Error("Worker terminated"));
      this.pending.clear();
    }
  }
  call(method, args, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const req = { __rpc: "req", id, method, args };
      this.worker.postMessage(req, transfer);
    });
  }
  handle(ev) {
    const data = ev.data;
    if (!isRpcMessage(data)) return;
    if (data.__rpc === "evt") {
      if (data.channel === "progress" && this.onProgress) {
        this.onProgress(data.payload);
      }
      return;
    }
    if (data.__rpc !== "res") return;
    const p = this.pending.get(data.id);
    if (!p) return;
    this.pending.delete(data.id);
    if (data.ok) p.resolve(data.value);
    else p.reject(Object.assign(new Error(data.error.message), { stack: data.error.stack }));
  }
};
export {
  OcrEngine,
  OcrEngineWorker
};
//# sourceMappingURL=index.js.map