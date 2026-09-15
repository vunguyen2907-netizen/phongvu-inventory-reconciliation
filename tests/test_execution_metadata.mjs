import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const helperBlock = html.match(
  /\/\/ --- EXECUTION METADATA HELPERS ---([\s\S]*?)\/\/ --- END EXECUTION METADATA HELPERS ---/
);

assert.ok(helperBlock, "Thiếu khối hàm xử lý người thực hiện và thời gian kiểm kê");
assert.match(
  html,
  /inventoryTimeCandidates[^\n]*ngày cập nhật/,
  "Phải nhận diện cột Ngày cập nhật của sheet KetQuaChiTiet"
);

const context = vm.createContext({});
vm.runInContext(
  `${helperBlock[1]};
   globalThis.summarizeExecutionMetadata = summarizeExecutionMetadata;
   globalThis.buildExecutionMetadataIndex = typeof buildExecutionMetadataIndex === "function" ? buildExecutionMetadataIndex : undefined;
   globalThis.resolveExecutionMetadata = typeof resolveExecutionMetadata === "function" ? resolveExecutionMetadata : undefined;`,
  context
);

assert.equal(
  typeof context.buildExecutionMetadataIndex,
  "function",
  "Phải có bộ lập chỉ mục người/thời gian theo Serial/LOT"
);
assert.equal(
  typeof context.resolveExecutionMetadata,
  "function",
  "Phải có bộ ghép người/thời gian vào dòng chi tiết serial"
);

const result = context.summarizeExecutionMetadata([
  { performedBy: "Nguyễn A", inventoryTime: "14/08/2026 09:05:33" },
  { performedBy: "Trần B", inventoryTime: "0.4236111111" },
  { performedBy: "Nguyễn A", inventoryTime: "09:05" },
  { performedBy: "", inventoryTime: "46248.378854166664" },
  { performedBy: "", inventoryTime: "" }
]);

assert.deepEqual(
  JSON.parse(JSON.stringify(result)),
  {
    performedBy: "Nguyễn A, Trần B",
    inventoryTime: "09:05, 10:10"
  }
);

const metadataIndex = context.buildExecutionMetadataIndex([
  {
    sku: "241202683",
    serial: " SCC2HQ7007DB0000503 ",
    performedBy: "Đỗ Hữu Nghĩa",
    inventoryTime: "15:07",
    qty: 0
  },
  {
    sku: "241202683",
    serial: "SCC2HQ7007DB0000999",
    performedBy: "Lê Quốc Toàn",
    inventoryTime: "14:17",
    qty: 1
  },
  {
    sku: "NO-SERIAL",
    serial: "",
    performedBy: "Trần B",
    inventoryTime: "09:10"
  },
  {
    sku: "NO-SERIAL",
    serial: "",
    performedBy: "Lê C",
    inventoryTime: "09:12"
  }
]);

const missingSerialMetadata = context.resolveExecutionMetadata(metadataIndex, {
  sku: "241202683",
  stockSerial: "scc2hq7007db0000503",
  scannedSerial: "",
  isNonSerial: false
});
assert.equal(
  missingSerialMetadata.performedBy,
  "Đỗ Hữu Nghĩa",
  "Dòng serial chưa được tính số lượng vẫn phải hiện người thực hiện nếu có trong KetQuaChiTiet"
);
assert.equal(missingSerialMetadata.inventoryTime, "15:07");

const sameSkuFallbackMetadata = context.resolveExecutionMetadata(metadataIndex, {
  sku: "241202683",
  stockSerial: "SERIAL-KHONG-CO-TRONG-KET-QUA",
  scannedSerial: "",
  isNonSerial: false
});
assert.equal(sameSkuFallbackMetadata.performedBy, "Đỗ Hữu Nghĩa, Lê Quốc Toàn");
assert.equal(sameSkuFallbackMetadata.inventoryTime, "15:07, 14:17");

const nonSerialMetadata = context.resolveExecutionMetadata(metadataIndex, {
  sku: "NO-SERIAL",
  stockSerial: "",
  scannedSerial: "",
  isNonSerial: true
});
assert.equal(nonSerialMetadata.performedBy, "Trần B, Lê C");
assert.equal(nonSerialMetadata.inventoryTime, "09:10, 09:12");

console.log("Execution metadata tests passed");
