export const normalizeTrendsUrl = (value) => {
  const clean = String(value || "").trim();
  return clean.startsWith("//") ? `https:${clean}` : clean;
};
