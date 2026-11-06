const DEFAULT_INDENT_DAYS = 20;

const normalizedKey = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

const INDENT_STATUS_KEYS = new Set([
  "indent",
  "indented",
  "isindented",
  "indentproduct",
  "indentedproduct",
]);

const INDENT_DAYS_KEYS = new Set([
  "indentday",
  "indentdays",
  "indentedday",
  "indenteddays",
]);

const positiveIndentValue = (value) => {
  if (value === true) return true;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!text || /^(?:false|no|n|0|stocked|in stock|not indented)$/i.test(text))
    return false;
  return (
    /^(?:true|yes|y|indented)(?:\b|\s*-)/i.test(text) ||
    /yes\s*-?\s*indented/i.test(text) ||
    /^\d+$/.test(text) ||
    /^\d+\s*(?:business|working|calendar)?\s*days?$/i.test(text)
  );
};

const daysFrom = (value) => {
  const match = String(value ?? "").match(/\b(\d{1,3})\b/);
  if (!match) return null;
  const days = Number(match[1]);
  return days > 0 ? days : null;
};

export function indentConfigurationFor(product, tags = []) {
  let isIndented = false;
  let days = null;

  for (const tag of tags) {
    const text = String(tag || "").trim();
    const statusMatch = text.match(/^indented\s+product\s*:\s*(.+)$/i);
    if (statusMatch && positiveIndentValue(statusMatch[1])) isIndented = true;
    const daysMatch = text.match(/^indent(?:ed)?\s+days?\s*:\s*(.+)$/i);
    if (daysMatch) {
      days = daysFrom(daysMatch[1]) || days;
      isIndented = isIndented || Boolean(days);
    }
  }

  const seen = new WeakSet();
  const visit = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    for (const [key, fieldValue] of Object.entries(value)) {
      const normalized = normalizedKey(key);
      if (
        INDENT_STATUS_KEYS.has(normalized) &&
        positiveIndentValue(fieldValue)
      ) {
        isIndented = true;
        days = daysFrom(fieldValue) || days;
      }
      if (INDENT_DAYS_KEYS.has(normalized)) {
        days = daysFrom(fieldValue) || days;
        isIndented = isIndented || Boolean(days);
      }
    }

    const label = value.name ?? value.label ?? value.key ?? value.field;
    const fieldValue = value.value ?? value.description ?? value.data;
    const normalizedLabel = normalizedKey(label);
    if (
      INDENT_STATUS_KEYS.has(normalizedLabel) &&
      positiveIndentValue(fieldValue)
    ) {
      isIndented = true;
      days = daysFrom(fieldValue) || days;
    }
    if (INDENT_DAYS_KEYS.has(normalizedLabel)) {
      days = daysFrom(fieldValue) || days;
      isIndented = isIndented || Boolean(days);
    }

    Object.values(value).forEach(visit);
  };
  visit(product);

  return {
    isIndented,
    days: isIndented ? days || DEFAULT_INDENT_DAYS : null,
  };
}

export function indentTagsFor(configuration) {
  if (!configuration?.isIndented) return [];
  return [
    "indented product: Yes - Indented",
    `indent days: ${configuration.days || DEFAULT_INDENT_DAYS}`,
  ];
}

export function withoutManagedIndentTags(tags = []) {
  return tags.filter(
    (tag) =>
      !/^indented\s+product\s*:/i.test(String(tag || "").trim()) &&
      !/^indent(?:ed)?\s+days?\s*:/i.test(String(tag || "").trim()),
  );
}
