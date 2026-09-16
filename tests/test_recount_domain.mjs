import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const domainUrl = new URL("../recount_domain.js", import.meta.url);
assert.ok(fs.existsSync(domainUrl), "Thiếu mô-đun recount_domain.js");

const domainCode = fs.readFileSync(domainUrl, "utf8");
const browserContext = { window: {} };
vm.runInNewContext(domainCode, browserContext);

const domain = browserContext.window.InventoryRecountDomain;
assert.equal(typeof domain, "object");
assert.equal(Object.isFrozen(domain), true);

const {
  normalizeInventoryCode,
  maskSerialGroup,
  buildRecountDraft,
  applyConfirmedRecounts
} = domain;

// A broken normalizer would miss aliases and fail server-side serial comparisons.
assert.equal(
  normalizeInventoryCode(" ab\u200b １２\u200cCd\u2060 \ufeff"),
  "AB12CD",
  "normalization must match the SQL NFKC/uppercase/whitespace contract"
);
assert.equal(normalizeInventoryCode(null), "");

// Revealing a whole short serial would expose the secret rather than a safe reference.
assert.deepEqual(
  [...maskSerialGroup(["12345678AB12"]).values()],
  ["********AB12"],
  "unique suffixes reveal only the last four characters"
);
assert.deepEqual(
  [...maskSerialGroup(["AAAA7X9QZZZZ", "AAAA2B4CZZZZ"]).values()],
  ["****7X9Q****", "****2B4C****"],
  "suffix collisions reveal the earliest differing four-character window"
);
assert.deepEqual(
  [...maskSerialGroup(["AAAA7X9QZZZZ", "AAAA2B4CZZZZ", "WXYZ9999AB12", "ZZZZ8888AB12"]).values()],
  ["****7X9Q****", "****2B4C****", "WXYZ********", "ZZZZ********"],
  "each colliding suffix group chooses its own earliest differing window"
);
assert.deepEqual(
  [...maskSerialGroup(["", "A", "ABCD", "ABCDE"]).values()],
  ["", "*", "****", "*BCDE"],
  "empty and short values never disclose a complete serial"
);
assert.deepEqual(
  [...maskSerialGroup(["ABCD", "XABCD"]).values()],
  ["****", "XABC*"],
  "unequal-length suffix collisions remain distinguishable without exposing a short code"
);
assert.equal(
  maskSerialGroup(["😀ABCDE"]).get("😀ABCDE"),
  "**BCDE",
  "mask positions count Unicode characters the same way as PostgreSQL char_length"
);

const detailRows = [
  {
    rowId: "SKU-A::0",
    sku: "SKU-A",
    name: "Missing unit",
    stockSerial: "ab 12\u200bcd",
    scannedSerial: "",
    bin: "STOCK-A",
    performedBy: " Counter\u3000One ",
    checked: 0,
    status: "Bắn thiếu (Chưa quét)"
  },
  {
    rowId: "SKU-B::1",
    sku: "SKU-B",
    name: "Wrong unit",
    stockSerial: "1111AAAAZZ99",
    scannedSerial: "first 77\u200c88",
    bin: "COUNT-B",
    performedBy: "counter one",
    checked: 1,
    status: "Bắn sai serial"
  },
  {
    rowId: "SKU-C::2",
    sku: "SKU-C",
    name: "Surplus unit",
    stockSerial: "",
    scannedSerial: "extra 99",
    bin: "COUNT-C",
    performedBy: "not mapped",
    checked: 1,
    status: "Bắn dư (Quét trùng Serial)"
  },
  {
    rowId: "SKU-D::3",
    sku: "SKU-D",
    name: "Already resolved",
    stockSerial: "resolved 99",
    scannedSerial: "resolved 99",
    bin: "DONE-D",
    performedBy: "counter one",
    checked: 1,
    status: "Đã quét đủ"
  },
  {
    rowId: "SKU-E::4",
    sku: "SKU-E",
    name: "Resolved discrepancy",
    stockSerial: "RESOLVED-E",
    scannedSerial: "EXTRA-E",
    bin: "DONE-E",
    performedBy: "counter one",
    checked: 1,
    status: "Bắn dư serial",
    recountResolution: "genuine_surplus"
  },
  {
    rowId: "SKU-F::5",
    sku: "SKU-F",
    name: "Non-serial shortage",
    stockSerial: "(Hàng không serial)",
    scannedSerial: "0 cái",
    bin: "COUNT-F",
    performedBy: "counter one",
    checked: 0,
    status: "Bắn thiếu 2 hàng (0/2)",
    isNonSerial: true
  }
];

const profiles = [
  { id: "user-1", erp_name: "COUNTER ONE", status: "active", full_name: "Counter One" },
  { id: "user-locked", erp_name: "LOCKED", status: "locked", full_name: "Locked User" }
];
const draft = buildRecountDraft(detailRows, profiles);

// Omitting an active discrepancy or assigning it to the wrong counter breaks the recount queue.
assert.deepEqual(
  draft.tasks.map(({ source_detail_row_id, task_type, assigned_user_id, state }) => ({
    source_detail_row_id,
    task_type,
    assigned_user_id,
    state
  })),
  [
    { source_detail_row_id: "SKU-A::0", task_type: "missing_serial", assigned_user_id: "user-1", state: "assigned" },
    { source_detail_row_id: "SKU-B::1", task_type: "wrong_serial", assigned_user_id: "user-1", state: "assigned" },
    { source_detail_row_id: "SKU-C::2", task_type: "surplus_scan", assigned_user_id: null, state: "unassigned" }
  ],
  "current discrepancy types become stable, correctly assigned recount tasks"
);
assert.equal(draft.tasks[0].masked_reference, "**12CD");
assert.equal(draft.tasks[1].masked_reference, "********ZZ99");
assert.equal(draft.tasks[2].masked_reference, "***RA99");
assert.equal(draft.tasks[0].first_counter_name_snapshot, "Counter One");
assert.equal(draft.evidence.length, 3, "every generated task retains protected source evidence");
assert.deepEqual(
  draft.evidence.map(({ source_detail_row_id, expected_serial_normalized, first_scanned_code_normalized }) => ({
    source_detail_row_id,
    expected_serial_normalized,
    first_scanned_code_normalized
  })),
  [
    { source_detail_row_id: "SKU-A::0", expected_serial_normalized: "AB12CD", first_scanned_code_normalized: "" },
    { source_detail_row_id: "SKU-B::1", expected_serial_normalized: "1111AAAAZZ99", first_scanned_code_normalized: "FIRST7788" },
    { source_detail_row_id: "SKU-C::2", expected_serial_normalized: "", first_scanned_code_normalized: "EXTRA99" }
  ]
);
assert.equal(
  draft.evidence[1].serial_normalized,
  "FIRST7788",
  "wrong-serial evidence records the code counted in round one, not the expected code"
);
assert.equal(draft.tasks.some(task => task.source_detail_row_id === "SKU-D::3"), false, "resolved rows create no active task");
assert.equal(draft.tasks.some(task => task.source_detail_row_id === "SKU-E::4"), false, "rows with a confirmed recount resolution stay resolved");
assert.equal(draft.tasks.some(task => task.source_detail_row_id === "SKU-F::5"), false, "non-serial quantity shortages do not become serial tasks");
assert.equal(JSON.stringify(draft.tasks).includes("AB12CD"), false, "public tasks never contain expected serials");
assert.equal(JSON.stringify(draft.tasks).includes("FIRST7788"), false, "public tasks never contain first-scanned serials");
assert.equal(JSON.stringify(draft.tasks).includes("EXTRA99"), false, "public tasks never contain first-scanned surplus codes");
for (const task of draft.tasks) {
  assert.ok((task.masked_reference.match(/[^*]/g) || []).length <= 4, "masked references reveal at most four characters");
}

// Silently choosing one duplicate active alias could assign sensitive work to the wrong person.
assert.throws(
  () => buildRecountDraft(detailRows, [
    { id: "user-2", erp_name: "counter one", status: "active" },
    { id: "user-1", erp_name: "COUNTER ONE", status: "active" }
  ]),
  /Duplicate active ERP alias: COUNTERONE/
);

const duplicateReferenceDraft = buildRecountDraft([
  {
    rowId: "DUP::0",
    sku: "DUP",
    name: "Duplicate reference one",
    stockSerial: "REPEAT99",
    scannedSerial: "",
    bin: "A",
    performedBy: "",
    checked: 0,
    status: "Bắn thiếu (Chưa quét)"
  },
  {
    rowId: "DUP::1",
    sku: "DUP",
    name: "Duplicate reference two",
    stockSerial: "REPEAT99",
    scannedSerial: "",
    bin: "B",
    performedBy: "",
    checked: 0,
    status: "Bắn thiếu (Chưa quét)"
  }
], []);
assert.equal(duplicateReferenceDraft.tasks.length, 2, "identical serial keys must not collapse distinct source tasks");
assert.deepEqual(
  duplicateReferenceDraft.tasks.map(task => task.source_detail_row_id),
  ["DUP::0", "DUP::1"]
);

const secretSnapshotDraft = buildRecountDraft([{
  rowId: "SAFE::0",
  sku: "SAFE-SKU",
  name: "Safe product",
  stockSerial: "LEAK123456",
  scannedSerial: "",
  bin: "SAFE-BIN",
  performedBy: " leak 123456 ",
  checked: 0,
  status: "Bắn thiếu (Chưa quét)"
}], [{
  id: "secret-user",
  erp_name: "LEAK123456",
  full_name: "LEAK123456",
  status: "active"
}]);
assert.equal(secretSnapshotDraft.tasks[0].assigned_user_id, "secret-user");
assert.equal(secretSnapshotDraft.tasks[0].first_counter_erp_name, null);
assert.equal(secretSnapshotDraft.tasks[0].first_counter_name_snapshot, null);
assert.equal(secretSnapshotDraft.tasks[0].assigned_name_snapshot, null);
assert.equal(
  normalizeInventoryCode(JSON.stringify(secretSnapshotDraft.tasks)).includes("LEAK123456"),
  false,
  "counter-facing snapshot fields must not provide a normalized full secret"
);

const mergeRows = [
  { rowId: "SKU::0", stockSerial: "STOCK0", scannedSerial: "OLD0", checked: 1, diff: 0, status: "Bắn sai serial" },
  { rowId: "SKU::1", stockSerial: "STOCK1", scannedSerial: "OLD1", checked: 1, diff: 1, status: "Bắn dư serial" },
  { rowId: "SKU::7", stockSerial: "STOCK7", scannedSerial: "DUP7", checked: 1, diff: 1, status: "Bắn dư serial" },
  { rowId: "SKU::8", stockSerial: "STOCK8", scannedSerial: "", checked: 0, diff: -1, status: "Bắn thiếu (Chưa quét)" },
  { rowId: "SKU::9", stockSerial: "STOCK9", scannedSerial: "", checked: 0, diff: -1, status: "Bắn thiếu (Chưa quét)" }
];

const merged = applyConfirmedRecounts(mergeRows, [
  { sourceDetailRowId: "SKU::0", resolution: "corrected_serial", confirmed: true, correctedSerial: "FIXED0" },
  { sourceDetailRowId: "SKU::1", resolution: "genuine_surplus", state: "completed", scannedSerial: "OLD1" },
  { sourceDetailRowId: "SKU::7", resolution: "same_product_multiple_codes" },
  { sourceDetailRowId: "SKU::8", resolution: "not_found", confirmed: true, reason: "not on shelf" },
  { sourceDetailRowId: "SKU::9", resolution: "corrected_serial", confirmed: true, correctedSerial: "FOUND9" }
]);

// Each confirmed branch has a distinct accounting effect; a pending task must not change totals.
assert.notEqual(merged, mergeRows, "merging produces a new detail-row collection");
assert.equal(merged[0].scannedSerial, "FIXED0");
assert.equal(merged[0].checked, 1);
assert.equal(merged[0].diff, 0);
assert.equal(merged[1].checked, 1, "manager-approved genuine surplus keeps its round-one quantity");
assert.equal(merged[1].diff, 1);
assert.equal(merged[1].l2Added, undefined, "genuine surplus must not be counted a second time as an L2 addition");
assert.equal(merged[1].recountResolution, "genuine_surplus", "a completed surplus task represents manager approval");
assert.equal(merged[2].excludedFromActual, true);
assert.equal(merged[2].checked, 0);
assert.equal(merged[3].checked, 0, "not-found keeps the original first-count quantity unchanged");
assert.equal(merged[3].diff, -1);
assert.equal(merged[3].recountResolution, "not_found");
assert.equal(merged[3].recountReason, "not on shelf");
assert.equal(merged[4].checked, 1);
assert.equal(merged[4].diff, 0);
assert.equal(merged[4].l2Added, true, "a corrected previously-missing serial contributes one supplemental unit");

const pending = applyConfirmedRecounts(mergeRows, [
  { sourceDetailRowId: "SKU::0", resolution: "corrected_serial", confirmed: false, correctedSerial: "UNCONFIRMED" },
  { sourceDetailRowId: "SKU::8", resolution: "genuine_surplus", confirmed: true, managerApproved: false, scannedSerial: "UNAPPROVED" }
]);
assert.deepEqual(pending, mergeRows, "unconfirmed or unapproved results leave raw detail rows unchanged");

console.log("Recount domain tests passed");
