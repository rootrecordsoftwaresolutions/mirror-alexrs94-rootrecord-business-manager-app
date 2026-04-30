'use strict';

const { DateTime } = require('luxon');

/**
 * @param {(key: string, def: unknown) => Promise<unknown>} settingsGet async read from app_settings
 */
async function resolveAppTimezone(settingsGet) {
  const raw = await settingsGet('business_timezone', 'system');
  /** Empty, `system`, invalid → `null` so callers use Luxon `'local'` (OS regional). */
  if (raw == null) return null;
  const name = String(raw).trim();
  if (name === '' || name.toLowerCase() === 'system') return null;
  const probe = DateTime.fromObject({ year: 2020, month: 6, day: 15 }, { zone: name });
  return probe.isValid ? name : null;
}

/** Luxon zone id: IANA name or `'local'` for OS default. */
async function effectiveReportingZone(settingsGet) {
  const tz = await resolveAppTimezone(settingsGet);
  return tz || 'local';
}

/** Current instant, expressed in the reporting zone (for "today" / week start wall calendar). */
async function nowInReportingZone(settingsGet) {
  const zone = await effectiveReportingZone(settingsGet);
  return DateTime.now().setZone(zone);
}

/** [startUtcNaiveIso, endUtcNaiveIso) for calendar day (y,m,d) interpreted in app timezone. */
async function utcNaiveBoundsForCalendarDay(settingsGet, y, month, day) {
  const tz = await resolveAppTimezone(settingsGet);
  const zone = tz || 'local';
  const lo = DateTime.fromObject({ year: y, month, day }, { zone }).startOf('day');
  const hi = lo.plus({ days: 1 });
  return [
    lo.toUTC().toISO({ suppressMilliseconds: true }).replace(/Z$/, ''),
    hi.toUTC().toISO({ suppressMilliseconds: true }).replace(/Z$/, '')
  ];
}

/** "Today" calendar parts in the reporting zone, then bounds for that day (matches summary_today / Dashboard Daily). */
async function utcNaiveBoundsForLocalToday(settingsGet) {
  const n = await nowInReportingZone(settingsGet);
  return utcNaiveBoundsForCalendarDay(settingsGet, n.year, n.month, n.day);
}

/** [startUtcNaive, endUtcNaive) for [startDate, endExclusive) wall calendar in app timezone. */
async function utcNaiveBoundsForLocalReportRange(settingsGet, sy, sm, sd, ey, em, ed) {
  const tz = await resolveAppTimezone(settingsGet);
  const zone = tz || 'local';
  const lo = DateTime.fromObject({ year: sy, month: sm, day: sd }, { zone }).startOf('day');
  const hi = DateTime.fromObject({ year: ey, month: em, day: ed }, { zone }).startOf('day');
  return [
    lo.toUTC().toISO({ suppressMilliseconds: true }).replace(/Z$/, ''),
    hi.toUTC().toISO({ suppressMilliseconds: true }).replace(/Z$/, '')
  ];
}

/** Scale id: Daily | Weekly | Monthly | Yearly | Custom — plus optional customDay {y,m,d} */
async function computeDashboardWindows(settingsGet, scale, customDay) {
  const tz = await resolveAppTimezone(settingsGet);
  const zone = tz || 'local';
  const now = DateTime.now().setZone(zone);
  const today = { y: now.year, m: now.month, d: now.day };
  let label = 'Today';
  let startUtc;
  let endUtc;
  let prevLabel = 'yesterday';
  let pStart;
  let pEnd;

  if (scale === 'Custom Day' && customDay) {
    const cd = customDay;
    [startUtc, endUtc] = await utcNaiveBoundsForCalendarDay(settingsGet, cd.y, cd.m, cd.d);
    label = `${cd.y}-${String(cd.m).padStart(2, '0')}-${String(cd.d).padStart(2, '0')}`;
    const prev = DateTime.fromObject({ year: cd.y, month: cd.m, day: cd.d }, { zone }).minus({ days: 1 });
    [pStart, pEnd] = await utcNaiveBoundsForCalendarDay(settingsGet, prev.year, prev.month, prev.day);
    prevLabel = 'prior day';
  } else if (scale === 'Daily') {
    [startUtc, endUtc] = await utcNaiveBoundsForLocalToday(settingsGet);
    const prev = now.minus({ days: 1 });
    [pStart, pEnd] = await utcNaiveBoundsForCalendarDay(settingsGet, prev.year, prev.month, prev.day);
  } else if (scale === 'Weekly') {
    const wd = now.weekday;
    const daysFromMon = wd === 7 ? 6 : wd - 1;
    const startOfWeek = now.minus({ days: daysFromMon }).startOf('day');
    const endOfWeek = startOfWeek.plus({ weeks: 1 });
    [startUtc, endUtc] = await utcNaiveBoundsForLocalReportRange(
      settingsGet,
      startOfWeek.year,
      startOfWeek.month,
      startOfWeek.day,
      endOfWeek.year,
      endOfWeek.month,
      endOfWeek.day
    );
    label = 'This week';
    const prevStart = startOfWeek.minus({ weeks: 1 });
    const prevEnd = startOfWeek;
    [pStart, pEnd] = await utcNaiveBoundsForLocalReportRange(
      settingsGet,
      prevStart.year,
      prevStart.month,
      prevStart.day,
      prevEnd.year,
      prevEnd.month,
      prevEnd.day
    );
    prevLabel = 'last week';
  } else if (scale === 'Monthly') {
    const start = DateTime.fromObject({ year: today.y, month: today.m, day: 1 }, { zone });
    const end = start.plus({ months: 1 });
    [startUtc, endUtc] = await utcNaiveBoundsForLocalReportRange(
      settingsGet,
      start.year,
      start.month,
      start.day,
      end.year,
      end.month,
      end.day
    );
    label = 'This month';
    const pstart = start.minus({ months: 1 });
    const pend = start;
    [pStart, pEnd] = await utcNaiveBoundsForLocalReportRange(
      settingsGet,
      pstart.year,
      pstart.month,
      pstart.day,
      pend.year,
      pend.month,
      pend.day
    );
    prevLabel = 'last month';
  } else {
    const start = DateTime.fromObject({ year: today.y, month: 1, day: 1 }, { zone });
    const end = start.plus({ years: 1 });
    [startUtc, endUtc] = await utcNaiveBoundsForLocalReportRange(
      settingsGet,
      start.year,
      start.month,
      start.day,
      end.year,
      end.month,
      end.day
    );
    label = 'This year';
    const pstart = start.minus({ years: 1 });
    const pend = start;
    [pStart, pEnd] = await utcNaiveBoundsForLocalReportRange(
      settingsGet,
      pstart.year,
      pstart.month,
      pstart.day,
      pend.year,
      pend.month,
      pend.day
    );
    prevLabel = 'last year';
  }

  return {
    startUtc,
    endUtc,
    label,
    prevStartUtc: pStart,
    prevEndUtc: pEnd,
    prevLabel
  };
}

/** Full-window segment (same bounds as the main timescale) for dashboard "Combined" tab. */
function combinedSegmentFromWindow(win) {
  return {
    label: 'Combined',
    detail: '',
    startUtc: win.startUtc,
    endUtc: win.endUtc,
    prevStartUtc: win.prevStartUtc,
    prevEndUtc: win.prevEndUtc,
    prevLabel: win.prevLabel
  };
}

/**
 * Sub-ranges for the dashboard "second row" of tabs.
 * Weekly → Combined + Mon–Sun. Monthly → Combined + week chunks. Yearly → Combined + months.
 * Daily/Custom → single segment.
 */
async function computeDashboardSegments(settingsGet, scale, customDay) {
  const win = await computeDashboardWindows(settingsGet, scale, customDay);
  const tz = await resolveAppTimezone(settingsGet);
  const zone = tz || 'local';

  if (scale === 'Daily' || scale === 'Custom Day') {
    return {
      segments: [
        {
          label: win.label,
          detail: '',
          startUtc: win.startUtc,
          endUtc: win.endUtc,
          prevStartUtc: win.prevStartUtc,
          prevEndUtc: win.prevEndUtc,
          prevLabel: win.prevLabel
        }
      ]
    };
  }

  if (scale === 'Weekly') {
    const segments = [combinedSegmentFromWindow(win)];
    const startUtcStr = win.startUtc;
    const startDt = DateTime.fromISO(String(startUtcStr).trim().replace(/Z$/, '') + 'Z', {
      zone: 'utc'
    })
      .setZone(zone)
      .startOf('day');

    for (let i = 0; i < 7; i++) {
      const d = startDt.plus({ days: i });
      const [s, e] = await utcNaiveBoundsForCalendarDay(settingsGet, d.year, d.month, d.day);
      const pd = d.minus({ days: 1 });
      const [ps, pe] = await utcNaiveBoundsForCalendarDay(settingsGet, pd.year, pd.month, pd.day);
      segments.push({
        label: d.toFormat('ccc'),
        detail: d.toFormat('LLL d'),
        startUtc: s,
        endUtc: e,
        prevStartUtc: ps,
        prevEndUtc: pe,
        prevLabel: 'prior day'
      });
    }
    return { segments };
  }

  if (scale === 'Monthly') {
    const segments = [combinedSegmentFromWindow(win)];
    const t0 = DateTime.fromISO(String(win.startUtc).trim().replace(/Z$/, '') + 'Z', { zone: 'utc' }).setZone(zone);
    const y = t0.year;
    const m = t0.month;
    const dim = DateTime.fromObject({ year: y, month: m, day: 15 }, { zone }).daysInMonth;

    let startDay = 1;
    let part = 1;
    while (startDay <= dim) {
      const endDay = Math.min(startDay + 6, dim);
      const lo = DateTime.fromObject({ year: y, month: m, day: startDay }, { zone }).startOf('day');
      const hi = lo.plus({ days: endDay - startDay + 1 }).startOf('day');
      const [s, e] = await utcNaiveBoundsForLocalReportRange(
        settingsGet,
        lo.year,
        lo.month,
        lo.day,
        hi.year,
        hi.month,
        hi.day
      );
      const spanDays = endDay - startDay + 1;
      const prevHi = lo;
      const prevLo = prevHi.minus({ days: spanDays });
      const [ps, pe] = await utcNaiveBoundsForLocalReportRange(
        settingsGet,
        prevLo.year,
        prevLo.month,
        prevLo.day,
        prevHi.year,
        prevHi.month,
        prevHi.day
      );
      segments.push({
        label: `Week ${part}`,
        detail: `Days ${startDay}–${endDay}`,
        startUtc: s,
        endUtc: e,
        prevStartUtc: ps,
        prevEndUtc: pe,
        prevLabel: `prior ${spanDays} d`
      });
      part += 1;
      startDay = endDay + 1;
    }
    return { segments };
  }

  /** Yearly → Combined + months */
  const segments = [combinedSegmentFromWindow(win)];
  const t0 = DateTime.fromISO(String(win.startUtc).trim().replace(/Z$/, '') + 'Z', { zone: 'utc' }).setZone(zone);
  const y = t0.year;
  for (let month = 1; month <= 12; month++) {
    const lo = DateTime.fromObject({ year: y, month, day: 1 }, { zone }).startOf('day');
    const hi = lo.plus({ months: 1 }).startOf('day');
    const [s, e] = await utcNaiveBoundsForLocalReportRange(
      settingsGet,
      lo.year,
      lo.month,
      lo.day,
      hi.year,
      hi.month,
      hi.day
    );
    const pLo = lo.minus({ months: 1 });
    const [ps, pe] = await utcNaiveBoundsForLocalReportRange(
      settingsGet,
      pLo.year,
      pLo.month,
      pLo.day,
      lo.year,
      lo.month,
      lo.day
    );
    segments.push({
      label: lo.toFormat('LLL'),
      detail: '',
      startUtc: s,
      endUtc: e,
      prevStartUtc: ps,
      prevEndUtc: pe,
      prevLabel: 'prior month'
    });
  }
  return { segments };
}

module.exports = {
  resolveAppTimezone,
  effectiveReportingZone,
  nowInReportingZone,
  utcNaiveBoundsForCalendarDay,
  utcNaiveBoundsForLocalToday,
  utcNaiveBoundsForLocalReportRange,
  computeDashboardWindows,
  computeDashboardSegments
};
