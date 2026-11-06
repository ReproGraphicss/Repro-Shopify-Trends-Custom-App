import { readSheet } from "read-excel-file/node";
import { parse } from "csv-parse/sync";

const normalizeHeader = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
const valueText = (value) =>
  value instanceof Date ? value.toISOString() : String(value ?? "").trim();

export async function parseSkuSheet(file) {
  const name = file.name || "upload";
  const extension = name.toLowerCase().split(".").pop();
  let rows;
  if (extension === "xlsx") {
    rows = await readSheet(Buffer.from(await file.arrayBuffer()));
  } else if (extension === "xls") {
    throw new Error(
      "Legacy .xls files are not supported. Save the sheet as .xlsx or .csv.",
    );
  } else {
    const text = await file.text();
    rows = parse(text, {
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
    });
  }
  if (!rows.length) throw new Error("The uploaded sheet is empty");
  const headers = rows[0].map(normalizeHeader);
  const codeIndex = headers.includes("code")
    ? headers.indexOf("code")
    : headers.indexOf("sku");
  if (codeIndex < 0)
    throw new Error('The sheet must contain a column named "code" or "sku"');
  const items = [];
  for (let index = 1; index < rows.length; index++) {
    const code = valueText(rows[index][codeIndex]);
    if (!code) continue;
    const metadata = {};
    headers.forEach((header, column) => {
      if (header && header !== "code" && header !== "sku") {
        const value = valueText(rows[index][column]);
        if (value) metadata[header] = value;
      }
    });
    const tags = Object.entries(metadata).map(([key, value]) =>
      `${key.replace(/_/g, " ")}: ${value}`.slice(0, 255),
    );
    items.push({ code, metadata, tags, rowNumber: index + 1 });
  }
  return { name, items };
}
