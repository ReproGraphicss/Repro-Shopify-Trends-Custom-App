import assert from "node:assert/strict";
import {
  indentConfigurationFor,
  indentTagsFor,
  withoutManagedIndentTags,
} from "../app/lib/trends-indent.js";

assert.deepEqual(
  indentConfigurationFor({}, ["indented product: Yes - Indented"]),
  { isIndented: true, days: 20 },
);

assert.deepEqual(
  indentConfigurationFor({
    indented_product: "Yes - Indented",
    indent_days: 35,
  }),
  { isIndented: true, days: 35 },
);

assert.deepEqual(
  indentConfigurationFor({
    attributes: [{ name: "Indent", value: "20 days" }],
  }),
  { isIndented: true, days: 20 },
);

assert.deepEqual(indentConfigurationFor({ indent: "No" }), {
  isIndented: false,
  days: null,
});

assert.deepEqual(indentTagsFor({ isIndented: true, days: 20 }), [
  "indented product: Yes - Indented",
  "indent days: 20",
]);

assert.deepEqual(
  withoutManagedIndentTags([
    "TRENDS",
    "Indented Product: Yes - Indented",
    "Indent Days: 10",
  ]),
  ["TRENDS"],
);

console.log("trends indent tests passed");
