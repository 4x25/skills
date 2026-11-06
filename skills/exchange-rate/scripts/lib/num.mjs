export function positiveNumber(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null;
    value = Number(text.replaceAll(',', ''));
  }
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function round(value, digits = 4) {
  const rounded = Number(value.toFixed(digits));
  return rounded === 0 ? 0 : rounded;
}

export function summarize(points, field) {
  const valid = points.filter(point => point[field] != null);
  if (valid.length === 0) return null;
  const first = valid[0];
  const last = valid.at(-1);
  const rates = valid.map(point => point[field]);
  const change = last[field] - first[field];
  return {
    count: valid.length,
    startDate: first.date,
    endDate: last.date,
    firstRate: first[field],
    lastRate: last[field],
    change: round(change),
    changePercent: round(change / first[field] * 100),
    minRate: Math.min(...rates),
    maxRate: Math.max(...rates),
  };
}
