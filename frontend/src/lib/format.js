// Tiny formatting helpers used everywhere.
export const cents = (n) => Number.isFinite(+n) ? +n : 0;

export function fmtMoney(amount_cents, currency = "USD") {
  const v = (cents(amount_cents) || 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(v);
  } catch {
    return `$${v.toFixed(2)}`;
  }
}

export function fmtHours(h) {
  if (!Number.isFinite(+h)) return "0.00 h";
  return `${(+h).toFixed(2)} h`;
}

export function fmtDateShort(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export function fmtDateOnly(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

export function fmtTimeOnly(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export function isoNow() {
  return new Date().toISOString();
}

export function startOfYearISO() {
  const d = new Date();
  d.setMonth(0, 1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function startOfMonthISO(year, monthIdx) {
  const d = new Date(year, monthIdx, 1, 0, 0, 0, 0);
  return d.toISOString();
}

export function endOfMonthISO(year, monthIdx) {
  const d = new Date(year, monthIdx + 1, 0, 23, 59, 59, 999);
  return d.toISOString();
}

export function durationHours(startIso, endIso) {
  try {
    const s = new Date(startIso).getTime();
    const e = new Date(endIso).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e)) return 0;
    return Math.max(0, (e - s) / 3_600_000);
  } catch {
    return 0;
  }
}

export const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function classNames(...xs) {
  return xs.filter(Boolean).join(" ");
}
