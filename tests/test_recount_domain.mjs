import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const domainUrl = new URL("../recount_domain.js", import.meta.url);
assert.ok(fs.existsSync(domainUrl), "Thiếu mô-đun recount_domain.js");

const domainCode = fs.readFileSync(domainUrl, "utf8");
const browserContext = { window: {} };
vm.runInNewContext(domainCode, browserContext);

assert.equal(typeof browserContext.window.InventoryRecountDomain, "object");
assert.deepEqual(
  Object.keys(browserContext.window.InventoryRecountDomain),
  [],
  "Mô-đun ban đầu phải chỉ xuất API rỗng"
);
assert.equal(Object.isFrozen(browserContext.window.InventoryRecountDomain), true);

console.log("Recount domain tests passed");
