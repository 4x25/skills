const CHINA_OFFSET = '+08:00';

export function fromCompactTime(value) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  if (!isValidParts(year, month, day, hour, minute, second)) return null;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${CHINA_OFFSET}`;
}

export function fromChinaDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(String(value ?? ''));
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  if (!isValidParts(year, month, day, hour, minute, second)) return null;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${CHINA_OFFSET}`;
}

export function formatChinaTime(iso) {
  if (!iso) return '--';
  if (iso.endsWith(CHINA_OFFSET)) {
    return iso.slice(0, 19).replace('T', ' ');
  }
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export function formatChinaMinute(iso) {
  if (!iso) return '--';
  return formatChinaTime(iso).slice(0, 16);
}

function isValidParts(year, month, day, hour, minute, second) {
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [y, mo, d, h, mi, s] = parts;

  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  if (h > 23 || mi > 59 || s > 59) return false;

  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return date.getUTCFullYear() === y
    && date.getUTCMonth() === mo - 1
    && date.getUTCDate() === d;
}
