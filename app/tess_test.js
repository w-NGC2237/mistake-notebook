const { createWorker } = require("tesseract.js");
(async () => {
  const t0 = Date.now();
  const worker = await createWorker("chi_sim", 1, { logger: () => {} });
  console.log("worker ready in", ((Date.now() - t0) / 1000).toFixed(1) + "s");
  const t1 = Date.now();
  const { data } = await worker.recognize("D:/新建文件夹 (2)/ocrtest.png");
  console.log("recognize in", ((Date.now() - t1) / 1000).toFixed(1) + "s");
  console.log("----");
  console.log(data.text);
  await worker.terminate();
})();
