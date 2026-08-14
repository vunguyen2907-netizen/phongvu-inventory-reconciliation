import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const helperBlock = html.match(
  /\/\/ --- EXECUTION METADATA HELPERS ---([\s\S]*?)\/\/ --- END EXECUTION METADATA HELPERS ---/
);

assert.ok(helperBlock, "Thiếu khối hàm xử lý người thực hiện và thời gian kiểm kê");

const context = vm.createContext({});
vm.runInContext(
  `${helperBlock[1]}; globalThis.summarizeExecutionMetadata = summarizeExecutionMetadata;`,
  context
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

console.log("Execution metadata tests passed");
