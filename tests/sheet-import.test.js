import assert from "node:assert/strict";
import { parseSkuSheet } from "../app/lib/sheet-import.server.js";

const skuOnly = await parseSkuSheet(
  new File(["sku,name\n123456,Sample product\n"], "sku-list.csv", {
    type: "text/csv",
  }),
);
assert.equal(skuOnly.items[0].code, "123456");
assert.deepEqual(skuOnly.items[0].metadata, { name: "Sample product" });

const codePreferred = await parseSkuSheet(
  new File(["sku,code,name\n999999,654321,Preferred code\n"], "both.csv", {
    type: "text/csv",
  }),
);
assert.equal(codePreferred.items[0].code, "654321");
assert.deepEqual(codePreferred.items[0].metadata, { name: "Preferred code" });

await assert.rejects(
  () =>
    parseSkuSheet(
      new File(["product,name\n123456,Missing header\n"], "invalid.csv", {
        type: "text/csv",
      }),
    ),
  /column named "code" or "sku"/,
);

console.log("sheet import header tests passed");
