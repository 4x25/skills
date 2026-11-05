export function round(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) return null;
  const number = Number(value);
  const factor = 10 ** digits;
  const sign = Math.sign(number);
  return (sign * Math.round((Math.abs(number) + Number.EPSILON) * factor)) / factor;
}
