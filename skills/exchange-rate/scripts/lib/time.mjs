const DAY_MS = 86_400_000;
const CHINA_OFFSET = '+08:00';

export function chinaDate(now = new Date()) {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

export function dateRange(days, now = new Date()) {
  if (!Number.isInteger(days) || days < 1) throw new RangeError('days must be a positive integer');
  const endDate = chinaDate(now);
  const startDate = new Date(Date.parse(`${endDate}T00:00:00Z`) - days * DAY_MS)
    .toISOString().slice(0, 10);
  return { startDate, endDate };
}

export function fromCompactDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  const [, year, month, day] = match;
  const date = `${year}-${month}-${day}`;
  return validDate(date) ? date : null;
}

export function fromChinaDateTime(value) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  const [, date, hour, minute, second] = match;
  if (!validDate(date) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    return null;
  }
  return `${date}T${hour}:${minute}:${second}${CHINA_OFFSET}`;
}

export function formatChinaTime(iso) {
  if (!iso) return '--';
  if (iso.endsWith(CHINA_OFFSET)) return iso.slice(0, 19).replace('T', ' ');
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(iso));
}

function validDate(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}
