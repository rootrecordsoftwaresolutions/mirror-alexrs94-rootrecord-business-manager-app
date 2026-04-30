/* global rootRecord, Chart */

const state = {
  userId: 1,
  /** From `rr-bootstrap` (`app.getVersion()`). */
  appVersion: '',
  /** Stripe Payment Link base URL from `licensePrepare` (optional `prefilled_email`). */
  proPaymentLinkBase: '',
  activeBusinessId: null,
  /** Sidebar target: suffix of section id (e.g. Dashboard → #panel-Dashboard). */
  navKey: 'Dashboard',
  financeSection: 'Money',
  dbPath: '',
  activeInvoiceId: null,
  /** Last license / entitlement snapshot from main process (`license-prepare` / `license-login`). */
  license: null,
  /** Dashboard sub-period tab; reset when timescale / custom day changes. */
  dashSegmentIndex: null
};

/** When set, `loadBusinessSettings` selects this business id in the dropdown (e.g. after "Add business"). */
let pendingBusSelectId = null;

/** Periodic "what are you working on?" while clocked in. */
let promptScheduleTimer = null;
/** After clock-in, first reminder uses `prompt_first_delay_sec`; later ones use `prompt_interval_sec`. */
let firstPromptAfterClockIn = true;
/** Only after the user chooses Clock in or Resume (break) this session — never from saved state alone (avoids surprise logs). */
let activityPromptsArmed = false;

/** Short copy when DB/bootstrap fails after auth — avoids a silent no-op (buttons re-enable, nothing changes). */
const BOOT_DATA_FAILED_HINT =
  'Could not load your saved data on this computer. Try again. If RootRecord is open elsewhere, close it first.';
/** Shown after successful license API login when local SQLite bootstrap fails (different from sign-in rejection). */
const BOOT_AFTER_LOGIN_FAILED_HINT =
  'Signed in online, but your local database did not open. Close other RootRecord windows or installers using this profile, then try again.';

/** `wireUi` must run once — retries after a failed DB open must not duplicate listeners. */
let uiWired = false;

function pl(extra) {
  const o = { userId: state.userId, ...extra };
  if (state.activeBusinessId !== null && state.activeBusinessId !== undefined) {
    o.activeBusinessId = state.activeBusinessId;
  }
  return o;
}

async function api(method, payload) {
  return rootRecord.api(method, payload || {});
}

function showErr(e) {
  const raw = e && e.message ? e.message : String(e);
  console.error('[RootRecord]', raw);
  const el = document.getElementById('toolbar-sub');
  if (el) el.textContent = '';
}

function utcNowNaive() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '').replace('Z', '');
}

function money(cents) {
  const n = Number(cents) || 0;
  return (n / 100).toFixed(2);
}

/** Match main `settingBool.parseSettingBool` — settings JSON can be bool, 0/1, or strings. */
function parseSettingBool(raw, defaultVal = false) {
  if (raw === undefined || raw === null) return defaultVal;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0' || s === '') return false;
  }
  return Boolean(raw);
}

let ianaTimeZonesSortedCache = null;
function getSortedIanaTimeZones() {
  if (ianaTimeZonesSortedCache) return ianaTimeZonesSortedCache;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') {
      ianaTimeZonesSortedCache = Intl.supportedValuesOf('timeZone').sort((a, b) => a.localeCompare(b));
      return ianaTimeZonesSortedCache;
    }
  } catch (_) {
    /* ignore */
  }
  ianaTimeZonesSortedCache = [
    'UTC',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Detroit',
    'Europe/London',
    'Europe/Paris',
    'Australia/Sydney'
  ];
  return ianaTimeZonesSortedCache;
}

let timeZoneSelectsPopulated = false;
function ensureTimezoneSelectsPopulated() {
  if (timeZoneSelectsPopulated) return;
  const prog = document.getElementById('prog-tz');
  const bus = document.getElementById('bus-timezone');
  if (!prog || !bus) return;
  timeZoneSelectsPopulated = true;
  const zones = getSortedIanaTimeZones();
  prog.innerHTML = '';
  const sys = document.createElement('option');
  sys.value = 'system';
  sys.textContent = 'Use system (OS regional settings)';
  prog.appendChild(sys);
  for (const z of zones) {
    const o = document.createElement('option');
    o.value = z;
    o.textContent = z;
    prog.appendChild(o);
  }
  bus.innerHTML = '';
  const inherit = document.createElement('option');
  inherit.value = '';
  inherit.textContent = 'Not set (follow Program Settings)';
  bus.appendChild(inherit);
  for (const z of zones) {
    const o = document.createElement('option');
    o.value = z;
    o.textContent = z;
    bus.appendChild(o);
  }
  prog.selectedIndex = 0;
  bus.selectedIndex = 0;
}

/** Apply value to a select; if the saved value is not in the list, append a temporary option so nothing is lost. */
function setTimezoneSelectValue(selectEl, value, emptyOptionValid) {
  if (!selectEl) return;
  const v = value === undefined || value === null ? '' : String(value).trim();
  if (v && ![...selectEl.options].some((o) => o.value === v)) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = `${v} (saved — pick a listed zone when ready)`;
    selectEl.appendChild(o);
  }
  if (emptyOptionValid) {
    selectEl.value = v;
    return;
  }
  selectEl.value = v === '' || v.toLowerCase() === 'system' ? 'system' : v;
}

function hasProPlan() {
  return Boolean(state.license && state.license.proUnlocked);
}

function isGuestLocalLicense() {
  return Boolean(state.license && state.license.guestLocal);
}

function syncGuestModeBanner() {
  const ban = document.getElementById('guest-mode-banner');
  if (!ban) return;
  ban.hidden = !isGuestLocalLicense();
}

function applyReportsPlanLock() {
  const lock = document.getElementById('reports-plan-lock');
  const body = document.getElementById('reports-body');
  if (!lock || !body) return;
  const pro = hasProPlan();
  lock.hidden = pro;
  body.hidden = !pro;
  refreshProUpgradeButtonVisibility();
}

async function enforceFreePlanConstraints() {
  if (hasProPlan()) return;
  try {
    const mb = await api('settingGet', pl({ key: 'multi_business_enabled', default: false }));
    if (parseSettingBool(mb)) {
      await api('settingSet', pl({ key: 'multi_business_enabled', value: false }));
      await api('settingSet', pl({ key: 'active_business_id', value: 1 }));
    }
  } catch (_) {
    /* ignore */
  }
}

/** @param {unknown} multiRaw setting value from `settingGet` */
function applyBusinessPlanUi(pro, multiRaw) {
  const hint = document.getElementById('bus-plan-hint');
  const row = document.querySelector('.business-add-row');
  const btnAdd = document.getElementById('btn-bus-add');
  const inp = document.getElementById('bus-new-name');
  const multi = document.getElementById('bus-multi');
  const footPref = document.getElementById('btn-bus-pref-save');
  if (hint) {
    if (!pro) {
      hint.hidden = false;
      hint.textContent =
        'Free plan: one active business profile. Adding another business or enabling multi-business requires Pro.';
    } else {
      hint.hidden = true;
      hint.textContent = '';
    }
  }
  if (row) row.style.opacity = pro ? '' : '0.55';
  if (btnAdd) btnAdd.disabled = !pro;
  if (inp) inp.disabled = !pro;
  if (multi) {
    multi.disabled = !pro;
    multi.checked = pro ? parseSettingBool(multiRaw) : false;
  }
  if (footPref) footPref.disabled = !pro;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function labelWorkMode(m) {
  const map = { off: 'Off the clock', working: 'Working', on_break: 'On a break' };
  return map[m] || (m ? String(m) : '—');
}

/** When null, wall times use the OS regional clock (same as Program Settings → “Use system”). */
let appWallClockTimeZone = null;

function isValidIntlTimeZone(name) {
  if (!name || typeof name !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: name }).format();
    return true;
  } catch {
    return false;
  }
}

async function refreshAppDisplayTimeZone() {
  try {
    const t = await api('settingGet', pl({ key: 'business_timezone', default: 'system' }));
    const s = t == null || t === undefined ? '' : String(t).trim();
    if (!s || s.toLowerCase() === 'system') {
      appWallClockTimeZone = null;
      return;
    }
    appWallClockTimeZone = isValidIntlTimeZone(s) ? s : null;
  } catch {
    appWallClockTimeZone = null;
  }
}

function formatWithAppWallClock(date, intlOptions) {
  const opts = intlOptions && typeof intlOptions === 'object' ? { ...intlOptions } : {};
  if (appWallClockTimeZone) opts.timeZone = appWallClockTimeZone;
  try {
    return date.toLocaleString(undefined, opts);
  } catch {
    return date.toLocaleString(undefined, intlOptions);
  }
}

/** DB stores UTC wall times without `Z`; interpret as UTC and show in app wall clock (OS when timezone unset / system). */
function displayLocalTime(iso) {
  if (iso == null || iso === '') return '—';
  try {
    let s = String(iso).trim();
    if (!s.endsWith('Z') && !/[+-]\d\d:?\d\d$/.test(s)) {
      s = `${s}Z`;
    }
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return '—';
    return formatWithAppWallClock(d);
  } catch {
    return '—';
  }
}

function applyThemeSetting(raw) {
  const t = raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
  if (t === 'system') {
    const light = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  } else {
    document.documentElement.setAttribute('data-theme', t);
  }
}

function updateTrackingActionButtons(st) {
  const idle = document.getElementById('tracking-btns-idle');
  const active = document.getElementById('tracking-btns-active');
  const mode = st && st.current_mode ? String(st.current_mode) : 'off';
  const busy = mode === 'working' || mode === 'on_break';
  if (idle) idle.hidden = busy;
  if (active) active.hidden = !busy;
  const bi = document.getElementById('btn-break-in');
  const bo = document.getElementById('btn-break-out');
  const ut = document.getElementById('btn-update-task');
  if (bi) bi.hidden = mode !== 'working';
  if (bo) bo.hidden = mode !== 'on_break';
  if (ut) ut.hidden = mode !== 'working';
}

/** When the activity prompt times out or is saved empty: keep the current task description (no suffix). */
function activityDescriptionFallback(st) {
  const base = String(st.current_work_description || st.last_task_description || 'Working').trim();
  return base || 'Working';
}

async function readPromptConfig() {
  const intervalSec = Math.max(60, Number(await api('settingGet', pl({ key: 'prompt_interval_sec', default: 900 }))) || 900);
  const firstSec = Math.max(30, Number(await api('settingGet', pl({ key: 'prompt_first_delay_sec', default: 120 }))) || 120);
  const timeoutSec = Math.max(10, Number(await api('settingGet', pl({ key: 'prompt_no_response_timeout_sec', default: 45 }))) || 45);
  return { intervalSec, firstSec, timeoutSec };
}

function clearActivityPromptSchedule() {
  if (promptScheduleTimer) {
    clearTimeout(promptScheduleTimer);
    promptScheduleTimer = null;
  }
}

/** Start or restart the periodic prompt timer (only while `working`). */
async function scheduleActivityPromptChain() {
  clearActivityPromptSchedule();
  if (!activityPromptsArmed) return;
  let st;
  try {
    st = await api('trackingStateGet', pl({}));
  } catch (_) {
    return;
  }
  if (st.current_mode !== 'working') return;
  const { intervalSec, firstSec } = await readPromptConfig();
  const delayMs = (firstPromptAfterClockIn ? firstSec : intervalSec) * 1000;
  firstPromptAfterClockIn = false;
  promptScheduleTimer = setTimeout(() => {
    runPeriodicActivityPrompt().catch(showErr);
  }, delayMs);
}

async function runPeriodicActivityPrompt() {
  promptScheduleTimer = null;
  if (!activityPromptsArmed) return;
  let st;
  try {
    st = await api('trackingStateGet', pl({}));
  } catch (e) {
    showErr(e);
    return;
  }
  if (st.current_mode !== 'working') return;

  const dlg = document.getElementById('dlg-activity');
  if (dlg && dlg.open) {
    await scheduleActivityPromptChain();
    return;
  }

  const { timeoutSec } = await readPromptConfig();
  const initial = String(st.current_work_description || st.last_task_description || '').trim();

  const r = await openActivityDialog({
    title: 'What are you working on?',
    subtitle: 'Confirm or update what you are working on (same as periodic reminders elsewhere in the app).',
    initialValue: initial,
    timeoutSec,
    timeoutResolveText: () => activityDescriptionFallback(st)
  });

  const wcEl = document.getElementById('man-cat');
  const wc = wcEl && wcEl.value ? parseInt(wcEl.value, 10) : null;
  let pj = null;
  try {
    pj = await resolveTrackingProjectId();
  } catch (e) {
    showErr(e);
    await scheduleActivityPromptChain();
    return;
  }

  try {
    if (!r.cancelled && r.timedOut) {
      const desc = r.resolvedText || activityDescriptionFallback(st);
      await api('logActivity', pl({ description: desc, work_category_id: wc, project_id: pj }));
    } else if (!r.cancelled && !r.timedOut) {
      let desc = String(r.value || '').trim();
      if (!desc) desc = initial || activityDescriptionFallback(st);
      await api('logActivity', pl({ description: desc, work_category_id: wc, project_id: pj }));
    }
  } catch (e) {
    showErr(e);
  }

  await loadTimeTracking();
  await scheduleActivityPromptChain();
}

/** Manual “new entry” while working — same server action as periodic prompts (`logActivity`). */
async function promptUpdateCurrentTask() {
  let st;
  try {
    st = await api('trackingStateGet', pl({}));
  } catch (e) {
    showErr(e);
    return;
  }
  if (!st || st.current_mode !== 'working') {
    showErr(new Error('Update current task is only available while you are working (not on a break or off the clock).'));
    return;
  }

  const dlg = document.getElementById('dlg-activity');
  if (dlg && dlg.open) return;

  const { timeoutSec } = await readPromptConfig();
  const initial = String(st.current_work_description || st.last_task_description || '').trim();

  const r = await openActivityDialog({
    title: 'Update current task',
    subtitle:
      'Starts a new time block with your description using the category and project selected above (same as switching tasks mid-session).',
    initialValue: initial,
    timeoutSec,
    timeoutResolveText: () => activityDescriptionFallback(st)
  });

  const wcEl = document.getElementById('man-cat');
  const wc = wcEl && wcEl.value ? parseInt(wcEl.value, 10) : null;
  let pj = null;
  try {
    pj = await resolveTrackingProjectId();
  } catch (e) {
    showErr(e);
    await scheduleActivityPromptChain();
    return;
  }

  try {
    if (!r.cancelled && r.timedOut) {
      const desc = r.resolvedText || activityDescriptionFallback(st);
      await api('logActivity', pl({ description: desc, work_category_id: wc, project_id: pj }));
    } else if (!r.cancelled && !r.timedOut) {
      let desc = String(r.value || '').trim();
      if (!desc) desc = initial || activityDescriptionFallback(st);
      await api('logActivity', pl({ description: desc, work_category_id: wc, project_id: pj }));
    }
  } catch (e) {
    showErr(e);
  }

  await loadTimeTracking();
  await scheduleActivityPromptChain();
}

/**
 * Modal for activity text. On timeout calls `timeoutResolveText` if provided.
 * @returns {{ cancelled: boolean, timedOut: boolean, value: string, resolvedText?: string }}
 */
async function openActivityDialog(opts) {
  const dlg = document.getElementById('dlg-activity');
  const titleEl = document.getElementById('dlg-act-title');
  const subEl = document.getElementById('dlg-act-sub');
  const ta = document.getElementById('dlg-act-text');
  const cdEl = document.getElementById('dlg-act-countdown');
  const okBtn = document.getElementById('dlg-act-ok');
  const cancelBtn = document.getElementById('dlg-act-cancel');
  if (!dlg || !ta || !okBtn || !cancelBtn) {
    return { cancelled: true, timedOut: false, value: '' };
  }

  titleEl.textContent = opts.title || 'Activity';
  subEl.textContent = opts.subtitle || '';
  subEl.style.display = opts.subtitle ? 'block' : 'none';
  ta.value = opts.initialValue != null ? String(opts.initialValue) : '';

  const timeoutSec =
    opts.timeoutSec != null ? Math.max(0, Number(opts.timeoutSec)) : (await readPromptConfig()).timeoutSec;

  return new Promise((resolve) => {
    let finished = false;
    let remaining = timeoutSec;
    let tickTimer = null;

    function cleanup() {
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = null;
    }

    function done(result) {
      if (finished) return;
      finished = true;
      cleanup();
      dlg.removeEventListener('cancel', onEsc);
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      try {
        dlg.close();
      } catch (_) {
        /* ignore */
      }
      resolve(result);
    }

    function onEsc(ev) {
      ev.preventDefault();
      done({ cancelled: true, timedOut: false, value: ta.value.trim() });
    }

    function onOk() {
      done({ cancelled: false, timedOut: false, value: ta.value.trim() });
    }

    function onCancel() {
      done({ cancelled: true, timedOut: false, value: ta.value.trim() });
    }

    dlg.addEventListener('cancel', onEsc);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);

    if (timeoutSec > 0 && cdEl) {
      cdEl.textContent = `Response timeout in ${remaining}s…`;
      tickTimer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          cleanup();
          const resolvedText = opts.timeoutResolveText ? opts.timeoutResolveText() : ta.value.trim() || 'Working';
          okBtn.removeEventListener('click', onOk);
          cancelBtn.removeEventListener('click', onCancel);
          dlg.removeEventListener('cancel', onEsc);
          finished = true;
          try {
            dlg.close();
          } catch (_) {
            /* ignore */
          }
          resolve({
            cancelled: false,
            timedOut: true,
            value: ta.value.trim(),
            resolvedText
          });
        } else if (cdEl) {
          cdEl.textContent = `Response timeout in ${remaining}s…`;
        }
      }, 1000);
    } else if (cdEl) {
      cdEl.textContent = '';
    }

    dlg.showModal();
    ta.focus();
    ta.select();
  });
}

function renderTrackingStatePanel(st, categoryById, projectById) {
  const el = document.getElementById('time-status');
  if (!el) return;
  if (!st || typeof st !== 'object') {
    el.textContent = 'No session information is available yet.';
    updateTrackingActionButtons({ current_mode: 'off' });
    return;
  }
  const catName =
    st.current_work_category_id != null
      ? categoryById[st.current_work_category_id] || `Category #${st.current_work_category_id}`
      : '—';
  const projName =
    st.current_project_id != null
      ? projectById[st.current_project_id] || `Project #${st.current_project_id}`
      : '—';
  const tagStr =
    st.current_tag_ids == null
      ? '—'
      : Array.isArray(st.current_tag_ids) && st.current_tag_ids.length
        ? st.current_tag_ids.join(', ')
        : '—';
  const rows = [
    ['Work status', labelWorkMode(st.current_mode)],
    ['What you are doing', st.current_work_description || '—'],
    ['Category', catName],
    ['Project', projName],
    ['Timer started', displayLocalTime(st.current_work_start_utc)],
    ['Last description', st.last_task_description || '—'],
    ['Tags', tagStr]
  ];
  el.innerHTML = rows
    .map(
      ([k, v]) =>
        `<div class="status-row"><span class="status-k">${escapeHtml(k)}</span><span class="status-v">${escapeHtml(
          v
        )}</span></div>`
    )
    .join('');
  updateTrackingActionButtons(st);
}

function todayLocalYmd() {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

function initDashDateDefault() {
  const { y, m, d } = todayLocalYmd();
  const el = document.getElementById('dash-custom-day');
  if (el) el.value = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function initReportDateDefaults() {
  const { y, m, d } = todayLocalYmd();
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const rs = document.getElementById('rep-start');
  const re = document.getElementById('rep-end');
  if (rs && !rs.value) rs.value = iso;
  if (re && !re.value) re.value = iso;
}

function initWorkLogDateDefaults() {
  const { y, m, d } = todayLocalYmd();
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const ws = document.getElementById('wl-start');
  const we = document.getElementById('wl-end');
  if (ws && !ws.value) ws.value = iso;
  if (we && !we.value) we.value = iso;
}

/** Dashboard custom day + empty report/worklog range fields use the same “today” as Program Settings → time zone. */
async function initCalendarDefaultsFromReportingZone() {
  let y;
  let m;
  let d;
  try {
    const tb = await todayBounds();
    if (
      tb &&
      Number.isFinite(tb.reportingYear) &&
      Number.isFinite(tb.reportingMonth) &&
      Number.isFinite(tb.reportingDay)
    ) {
      y = tb.reportingYear;
      m = tb.reportingMonth;
      d = tb.reportingDay;
    } else {
      const x = todayLocalYmd();
      y = x.y;
      m = x.m;
      d = x.d;
    }
  } catch {
    const x = todayLocalYmd();
    y = x.y;
    m = x.m;
    d = x.d;
  }
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const el = document.getElementById('dash-custom-day');
  if (el) el.value = iso;
  const rs = document.getElementById('rep-start');
  const re = document.getElementById('rep-end');
  if (rs && !rs.value) rs.value = iso;
  if (re && !re.value) re.value = iso;
  const ws = document.getElementById('wl-start');
  const we = document.getElementById('wl-end');
  if (ws && !ws.value) ws.value = iso;
  if (we && !we.value) we.value = iso;
}

/** Last merged Work Log payload (session + time); filtered client-side by search / category. */
let worklogMergedCache = [];

function isTimeEntryWorkCategoryOption(c) {
  const k = String(c.kind || 'time').toLowerCase();
  return k === 'time' || k === 'both';
}

function formatWorklogTimeEntryTypeCell(r) {
  const name = r.category_name != null ? String(r.category_name).trim() : '';
  if (name) return name;
  if (r.work_category_id != null) return `Category #${r.work_category_id}`;
  const leg = r.category != null ? String(r.category).trim() : '';
  if (leg) {
    const low = leg.toLowerCase();
    if (low === 'work') return 'Tracked time';
    if (low === 'evaluation') return 'Evaluation';
    /** Older rows / imports sometimes used `action` (see migrations around “Action” category rename). */
    if (low === 'action') return 'Work';
    return leg;
  }
  return 'Tracked time';
}

const WL_SESSION_EVENT_LABELS = {
  clock_in: 'Clock in',
  clock_out: 'Clock out',
  break_in: 'Break (start)',
  break_out: 'Break (end)',
  activity_update: 'Activity prompt',
  first_entry: 'First entry'
};

function formatWorklogSessionTypeCell(raw) {
  const t = String(raw || '').trim();
  if (!t) return '';
  if (WL_SESSION_EVENT_LABELS[t]) return WL_SESSION_EVENT_LABELS[t];
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function populateWorklogCategoryFilterSelect(categoriesForTime) {
  const sel = document.getElementById('wl-filter-cat');
  if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = '';
  const o0 = document.createElement('option');
  o0.value = '';
  o0.textContent = 'All categories';
  sel.appendChild(o0);
  const oU = document.createElement('option');
  oU.value = '__none__';
  oU.textContent = 'Uncategorized time';
  sel.appendChild(oU);
  const sorted = [...categoriesForTime].sort(
    (a, b) => (a.sort_order || 0) - (b.sort_order || 0) || String(a.name).localeCompare(String(b.name))
  );
  for (const c of sorted) {
    const o = document.createElement('option');
    o.value = String(c.id);
    o.textContent = c.name;
    sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  else sel.value = '';
}

function worklogSessionSearchText(r) {
  const raw = [r.event_type, r.detail, r.created_at_utc]
    .map((x) => (x != null ? String(x) : ''))
    .join(' ');
  const human = formatWorklogSessionTypeCell(r.event_type);
  return `${raw} ${human}`.toLowerCase();
}

function worklogTimeEntrySearchText(r) {
  return [r.category_name, r.description, r.category, r.start_utc, r.end_utc, r.project_name]
    .map((x) => (x != null ? String(x) : ''))
    .join(' ')
    .toLowerCase();
}

function worklogItemPassesCategoryFilter(item, catFilter) {
  if (!catFilter) return true;
  if (item.kind !== 'time') return false;
  if (catFilter === '__none__') {
    return item.row.work_category_id == null || item.row.work_category_id === '';
  }
  return String(item.row.work_category_id) === catFilter;
}

function worklogItemPassesSearch(item, qNorm) {
  if (!qNorm) return true;
  if (item.kind === 'session') return worklogSessionSearchText(item.row).includes(qNorm);
  return worklogTimeEntrySearchText(item.row).includes(qNorm);
}

function getWorklogFilterQuery() {
  const el = document.getElementById('wl-search');
  return (el && el.value ? String(el.value) : '').trim().toLowerCase();
}

function getWorklogCategoryFilter() {
  const el = document.getElementById('wl-filter-cat');
  return el ? String(el.value || '') : '';
}

function applyWorklogFilters() {
  const q = getWorklogFilterQuery();
  const cat = getWorklogCategoryFilter();
  const filtered = worklogMergedCache.filter(
    (item) => worklogItemPassesCategoryFilter(item, cat) && worklogItemPassesSearch(item, q)
  );
  renderWorklogMergedRows(filtered);
  const selAll = document.getElementById('wl-select-all');
  if (selAll) selAll.checked = false;
  updateWorklogBulkButtons();
}

function renderWorklogMergedRows(items) {
  const tb = document.querySelector('#worklog-table tbody');
  if (!tb) return;
  tb.innerHTML = '';
  for (const item of items) {
    const tr = document.createElement('tr');
    const r = item.row;

    const ck = document.createElement('td');
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.className = 'wl-row-check';
    inp.setAttribute('data-kind', item.kind);
    inp.setAttribute('data-id', String(r.id));
    inp.setAttribute('aria-label', 'Select row');
    inp.addEventListener('change', () => {
      updateWorklogBulkButtons();
      syncWorklogSelectAll();
    });
    ck.appendChild(inp);

    const timeTd = document.createElement('td');
    const typeTd = document.createElement('td');
    const detTd = document.createElement('td');

    if (item.kind === 'session') {
      timeTd.className = 'worklog-col-time';
      timeTd.textContent = r.created_at_utc != null ? displayLocalTime(r.created_at_utc) : '';
      typeTd.textContent = formatWorklogSessionTypeCell(r.event_type);
      detTd.textContent = r.detail != null ? String(r.detail) : '';
    } else {
      const st = r.start_utc != null ? displayLocalTime(r.start_utc) : '';
      const en = r.end_utc != null ? displayLocalTime(r.end_utc) : '';
      timeTd.className = 'worklog-col-time';
      timeTd.textContent = st && en ? `${st} → ${en}` : st || en;
      typeTd.textContent = formatWorklogTimeEntryTypeCell(r);
      detTd.textContent = r.description != null ? String(r.description) : '';
    }

    const actTd = document.createElement('td');
    actTd.className = 'worklog-row-actions';
    const btnEd = document.createElement('button');
    btnEd.type = 'button';
    btnEd.textContent = 'Edit';
    const btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.textContent = 'Delete';
    if (item.kind === 'session') {
      btnEd.addEventListener('click', () => openWorklogEditDialog(r));
      btnDel.addEventListener('click', () => deleteWorklogRow(r.id));
    } else {
      btnEd.addEventListener('click', () => openTimeEntryEditDialog(r));
      btnDel.addEventListener('click', async () => {
        if (!confirm('Delete this tracked time block?')) return;
        try {
          await api('deleteTimeEntry', pl({ entry_id: r.id }));
          await loadWorkLog();
        } catch (e) {
          showErr(e);
        }
      });
    }
    actTd.appendChild(btnEd);
    actTd.appendChild(btnDel);

    tr.appendChild(ck);
    tr.appendChild(timeTd);
    tr.appendChild(typeTd);
    tr.appendChild(detTd);
    tr.appendChild(actTd);
    tb.appendChild(tr);
  }
  syncWorklogSelectAll();
}

/** DB stores UTC timestamps without `Z`; interpret as UTC for editing as local wall time. */
function utcNaiveToDatetimeLocal(iso) {
  let s = String(iso || '').trim();
  if (!s) return '';
  if (!s.endsWith('Z') && !/[+-]\d\d:?\d\d$/.test(s)) {
    s = `${s}Z`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `<input type="datetime-local">` value → UTC naive string stored by the app. */
function datetimeLocalToUtcNaive(val) {
  const v = String(val || '').trim();
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, '').replace(/Z$/, '');
}

/** @returns {{ kind: string, id: number }[]} */
function getSelectedWorklogSelection() {
  const boxes = document.querySelectorAll('#worklog-table tbody input.wl-row-check:checked');
  return [...boxes]
    .map((el) => ({
      kind: el.getAttribute('data-kind') || '',
      id: parseInt(el.getAttribute('data-id'), 10)
    }))
    .filter((x) => Number.isFinite(x.id));
}

function getSelectedWorklogSessionIds() {
  return getSelectedWorklogSelection()
    .filter((x) => x.kind === 'session')
    .map((x) => x.id);
}

function updateWorklogBulkButtons() {
  const sel = getSelectedWorklogSelection();
  const n = sel.length;
  const onlySessions = n > 0 && sel.every((s) => s.kind === 'session');
  const be = document.getElementById('btn-wl-bulk-edit');
  const bd = document.getElementById('btn-wl-bulk-delete');
  if (be) be.disabled = !onlySessions;
  if (bd) bd.disabled = n === 0;
}

function syncWorklogSelectAll() {
  const selAll = document.getElementById('wl-select-all');
  const boxes = document.querySelectorAll('#worklog-table tbody .wl-row-check');
  if (!selAll || !boxes.length) return;
  selAll.checked = [...boxes].every((b) => b.checked);
}

async function todayBounds() {
  return api('todayUtcBounds', pl());
}

function setNavPanel(panelKey, displayTitle) {
  if (!panelKey) return;
  state.navKey = panelKey;
  const title =
    displayTitle && String(displayTitle).trim() ? String(displayTitle).trim() : panelKey;
  document.querySelectorAll('.nav-btn').forEach((b) => {
    const k = b.getAttribute('data-panel') || '';
    b.classList.toggle('active', k === panelKey);
  });
  document.querySelectorAll('.panel').forEach((p) => {
    p.classList.toggle('active', p.id === `panel-${panelKey}`);
  });
  const toolbarTitle = document.getElementById('toolbar-title');
  if (toolbarTitle) toolbarTitle.textContent = title;
  refreshPanelForKey(panelKey).catch(showErr);
}

async function refreshPanelForKey(panelKey) {
  switch (panelKey) {
    case 'Dashboard':
      return loadDashboard();
    case 'Time-Tracking':
      return loadTimeTracking();
    case 'Finance-Clients':
      return loadFinance();
    case 'Schedule-Bookings':
      return loadSchedule();
    case 'Stock-Supplies':
      return loadStock();
    case 'Work-Log':
      return loadWorkLog();
    case 'Reports':
      return loadReports();
    case 'Account-Settings':
      return loadAccount();
    case 'Business-Settings':
      return loadBusinessSettings();
    case 'About-Help':
      return loadAbout();
    case 'Feedback':
      return loadFeedback();
    case 'Program-Settings':
      return loadProgramSettings();
    default:
      return undefined;
  }
}

/** Default dashboard segment: Combined (full window); index 0 matches new first tab. */
function defaultDashSegmentIndex() {
  return 0;
}

function dashToolbarPayload() {
  const scale = document.getElementById('dash-scale').value;
  const breakdownMode = document.getElementById('dash-bd-mode').value;
  let customDay = null;
  if (scale === 'Custom Day') {
    const v = document.getElementById('dash-custom-day').value;
    if (v) {
      const [y, m, d] = v.split('-').map((x) => parseInt(x, 10));
      customDay = { y, m, d };
    }
  }
  const segIdx =
    typeof state.dashSegmentIndex === 'number' && Number.isFinite(state.dashSegmentIndex)
      ? state.dashSegmentIndex
      : defaultDashSegmentIndex();
  return { scale, breakdownMode, customDay, includeAvailableFunds: true, segmentIndex: segIdx };
}

function destroyChart(ref) {
  if (ref && typeof ref.destroy === 'function') ref.destroy();
  return null;
}

/** Pie/bar segment colors — anchored to app accent (teal), muted sat/lightness for dark chrome (#1a1b22 / panels). */
function dashboardSegmentColors(count) {
  const curated = [
    'hsl(186 46% 52%)',
    'hsl(204 40% 56%)',
    'hsl(218 36% 58%)',
    'hsl(168 38% 48%)',
    'hsl(148 34% 50%)',
    'hsl(38 42% 58%)',
    'hsl(276 30% 60%)',
    'hsl(328 36% 58%)',
    'hsl(156 36% 48%)',
    'hsl(94 32% 50%)',
    'hsl(22 38% 58%)',
    'hsl(232 34% 58%)'
  ];
  const out = [];
  const baseHue = 186;
  const golden = 137.508;
  for (let i = 0; i < count; i += 1) {
    if (i < curated.length) {
      out.push(curated[i]);
    } else {
      const h = Math.round((baseHue + i * golden) % 360);
      out.push(`hsl(${h} 34% 54%)`);
    }
  }
  return out;
}

function renderPieBar(pieCanvasId, barCanvasId, breakdown, windowKey) {
  if (typeof Chart === 'undefined') return;
  const labels = breakdown.map((r) => r.task_name);
  const hours = breakdown.map((r) => Math.round((r.seconds_total / 3600) * 1000) / 1000);
  const colors = dashboardSegmentColors(labels.length);

  const pieEl = document.getElementById(pieCanvasId);
  const barEl = document.getElementById(barCanvasId);
  if (!pieEl || !barEl) return;

  const pk = `${windowKey}Pie`;
  const bk = `${windowKey}Bar`;
  window[pk] = destroyChart(window[pk]);
  window[bk] = destroyChart(window[bk]);

  if (!labels.length) {
    const ctx = pieEl.getContext('2d');
    ctx.clearRect(0, 0, pieEl.width, pieEl.height);
    const ctx2 = barEl.getContext('2d');
    ctx2.clearRect(0, 0, barEl.width, barEl.height);
    return;
  }

  const pieBorder = 'rgb(26, 27, 34)';
  window[pk] = new Chart(pieEl, {
    type: 'pie',
    data: {
      labels,
      datasets: [
        {
          data: hours,
          backgroundColor: colors,
          borderColor: pieBorder,
          borderWidth: 2,
          hoverOffset: 6
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: '#c8cad4' } } }
    }
  });
  window[bk] = new Chart(barEl, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Hours',
          data: hours,
          backgroundColor: colors,
          borderColor: colors.map(() => 'rgba(26, 27, 34, 0.45)'),
          borderWidth: 1,
          borderRadius: 6
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#9aa0b4' }, grid: { color: '#343746' } },
        y: { beginAtZero: true, ticks: { color: '#9aa0b4' }, grid: { color: '#343746' } }
      }
    }
  });
}

function renderDashSegmentTabs(data) {
  const wrap = document.getElementById('dash-segment-tabs-wrap');
  const host = document.getElementById('dash-segment-tabs');
  if (!wrap || !host) return;
  const segs = data.segments || [];
  if (segs.length <= 1) {
    wrap.hidden = true;
    host.innerHTML = '';
    return;
  }
  wrap.hidden = false;
  const activeIdx = data.segmentIndex != null ? data.segmentIndex : 0;
  state.dashSegmentIndex = activeIdx;
  host.innerHTML = '';
  for (const s of segs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dash-segment-tab' + (s.index === activeIdx ? ' active' : '');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', s.index === activeIdx ? 'true' : 'false');
    b.dataset.segmentIndex = String(s.index);
    b.title = s.detail ? `${s.label} · ${s.detail}` : s.label;
    b.textContent = s.detail ? `${s.label} (${s.detail})` : s.label;
    b.addEventListener('click', () => {
      state.dashSegmentIndex = s.index;
      loadDashboard().catch(showErr);
    });
    host.appendChild(b);
  }
}

async function loadDashboard() {
  initDashDateDefault();
  const dashCustomWrap = document.getElementById('dash-custom-wrap');
  const scale = document.getElementById('dash-scale').value;
  dashCustomWrap.style.display = scale === 'Custom Day' ? 'flex' : 'none';

  const p = dashToolbarPayload();
  const data = await api('getDashboardSummary', pl(p));
  const win = data.window;
  const sum = data.summary;
  const prev = data.previousSummary;
  const range = data.activeUtcRange || {
    startUtc: win.startUtc,
    endUtc: win.endUtc,
    prevStartUtc: win.prevStartUtc,
    prevEndUtc: win.prevEndUtc
  };
  const cardScope = data.periodCardLabel || win.label;
  const cmpLabel = data.comparePrevLabel != null ? data.comparePrevLabel : win.prevLabel;

  if (data.segmentIndex != null) state.dashSegmentIndex = data.segmentIndex;

  renderDashSegmentTabs(data);

  const segCount = (data.segments || []).length;
  const si = data.segmentIndex != null ? data.segmentIndex : 0;
  const seg = (data.segments || [])[si] || {};
  document.getElementById('dash-window-label').textContent =
    segCount > 1
      ? seg.label === 'Combined'
        ? `Window: ${win.label}`
        : `Window: ${win.label} · ${seg.label || ''}${seg.detail ? ` (${seg.detail})` : ''}`
      : `Window: ${win.label}`;
  document.getElementById('dash-card-hours-lbl').textContent = `Hours (${cardScope})`;
  document.getElementById('dash-card-inc-lbl').textContent = `Income (${cardScope})`;
  document.getElementById('dash-card-exp-lbl').textContent = `Expenses (${cardScope})`;
  document.getElementById('dash-card-net-lbl').textContent = `Net (${cardScope})`;

  document.getElementById('dash-hours').textContent = (sum.seconds_worked_approx / 3600).toFixed(2);
  document.getElementById('dash-income').textContent = money(sum.income_cents);
  document.getElementById('dash-expense').textContent = money(sum.expense_cents);
  const net = sum.income_cents - sum.expense_cents;
  const netEl = document.getElementById('dash-net');
  netEl.textContent = money(net);
  netEl.style.color = net >= 0 ? 'var(--ok)' : 'var(--danger)';

  const ph = (prev.seconds_worked_approx / 3600).toFixed(2);
  const pn = prev.income_cents - prev.expense_cents;
  document.getElementById('dash-compare').textContent = `${cmpLabel}: ${ph} h · net ${money(pn)} (comparison period)`;

  const ledger = await api('ledgerNetTotals', pl());
  const ledEl = document.getElementById('dash-ledger');
  const parts = Object.entries(ledger).map(([ccy, v]) => `${ccy}: net ${money(v.net_cents)}`);
  ledEl.textContent = parts.length ? `All-time ledger: ${parts.join(' · ')}` : 'No ledger totals yet.';

  const moneyParts = Object.entries(data.moneyByCurrency || {}).map(
    ([ccy, v]) => `${ccy}: in ${money(v.income_cents)} · out ${money(v.expense_cents)} · net ${money(v.net_cents)}`
  );
  document.getElementById('dash-money-strip').textContent = moneyParts.length ? `Period money: ${moneyParts.join(' · ')}` : '';

  const ft = data.availableFundsTotals;
  if (ft && Object.keys(ft).length) {
    const fs = Object.entries(ft).map(([ccy, b]) => `${ccy}: avail ${money(b.available_cents)} (bal ${money(b.balance_cents)})`);
    document.getElementById('dash-funds-strip').textContent = `Available funds: ${fs.join(' · ')}`;
  } else {
    document.getElementById('dash-funds-strip').textContent = '';
  }

  const bd = data.breakdown || [];
  const col1 = data.breakdownMode === 'Project' ? 'Project' : 'Category';
  document.getElementById('dash-bd-col1').textContent = col1;

  renderPieBar('dash-pie', 'dash-bar', bd, `dash-${data.segmentIndex ?? 0}`);

  const rh = document.getElementById('dash-recent-heading');
  if (rh) {
    rh.textContent =
      segCount > 1 && seg.label !== 'Combined' ? `Recent time (${cardScope})` : 'Recent time (window)';
  }

  const recent = await api('listTimeEntriesBetween', pl({ startUtc: range.startUtc, endUtc: range.endUtc }));
  const tb = document.querySelector('#dash-recent tbody');
  tb.innerHTML = '';
  for (const r of recent.slice(-40).reverse()) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(displayLocalTime(r.start_utc))}</td><td>${escapeHtml(r.category_name || r.category || '')}</td><td>${escapeHtml(
      r.description || ''
    )}</td><td>${r.amount_cents != null ? money(r.amount_cents) : '—'}</td>`;
    tb.appendChild(tr);
  }

  const bt = document.querySelector('#dash-bd-table tbody');
  bt.innerHTML = '';
  for (const r of bd) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(r.task_name)}</td><td>${(r.seconds_total / 3600).toFixed(2)} h</td><td>${r.percent_of_day.toFixed(1)}%</td>`;
    bt.appendChild(tr);
  }
}

function switchFinance(sec) {
  state.financeSection = sec;
  document.querySelectorAll('#panel-Finance-Clients .subnav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.sec === sec);
  });
  document.querySelectorAll('[data-finance-sec]').forEach((el) => {
    el.style.display = el.getAttribute('data-finance-sec') === sec ? 'block' : 'none';
  });
  if (sec === 'Money') loadFinanceMoney();
  if (sec === 'Clients') loadFinanceClients();
  if (sec === 'Invoices') loadFinanceInvoices();
  if (sec === 'Debts') loadFinanceDebts();
  if (sec === 'Funds') loadFinanceFunds();
  if (sec === 'Scheduled') loadFinanceScheduled();
  if (sec === 'Resources') loadFinanceResources();
  if (sec === 'Tax Estimator') loadFinanceTax();
}

async function loadFinance() {
  switchFinance(state.financeSection);
}

function openEditIncomeDialog(r) {
  document.getElementById('fin-inc-edit-id').value = String(r.id);
  document.getElementById('fin-inc-edit-amt').value = money(r.amount_cents);
  document.getElementById('fin-inc-edit-desc').value = r.description || '';
  document.getElementById('fin-inc-edit-when').value = utcNaiveToDatetimeLocal(r.received_at_utc);
  const cur = document.getElementById('fin-inc-edit-cur');
  if (cur && r.currency) cur.value = r.currency;
  document.getElementById('dlg-fin-income').showModal();
}

async function saveIncomeEdit() {
  const id = parseInt(document.getElementById('fin-inc-edit-id').value, 10);
  const amt = parseFloat(document.getElementById('fin-inc-edit-amt').value);
  if (!Number.isFinite(amt)) {
    showErr(new Error('Enter a valid amount.'));
    return;
  }
  const when = datetimeLocalToUtcNaive(document.getElementById('fin-inc-edit-when').value);
  if (!when) {
    showErr(new Error('Enter a valid date and time.'));
    return;
  }
  try {
    await api('updateIncome', pl({
      id,
      received_at_utc: when,
      amount_cents: Math.round(amt * 100),
      currency: document.getElementById('fin-inc-edit-cur').value,
      description: document.getElementById('fin-inc-edit-desc').value.trim()
    }));
    document.getElementById('dlg-fin-income').close();
    await loadFinanceMoney();
    if (state.navKey === 'Dashboard') await loadDashboard();
  } catch (e) {
    showErr(e);
  }
}

async function deleteIncomeEdit() {
  const id = parseInt(document.getElementById('fin-inc-edit-id').value, 10);
  if (!confirm('Delete this income entry?')) return;
  try {
    await api('deleteIncome', pl({ id }));
    document.getElementById('dlg-fin-income').close();
    await loadFinanceMoney();
    if (state.navKey === 'Dashboard') await loadDashboard();
  } catch (e) {
    showErr(e);
  }
}

function openEditExpenseDialog(r) {
  document.getElementById('fin-exp-edit-id').value = String(r.id);
  document.getElementById('fin-exp-edit-amt').value = money(r.amount_cents);
  document.getElementById('fin-exp-edit-desc').value = r.description || '';
  document.getElementById('fin-exp-edit-when').value = utcNaiveToDatetimeLocal(r.spent_at_utc);
  const cur = document.getElementById('fin-exp-edit-cur');
  if (cur && r.currency) cur.value = r.currency;
  const fund = document.getElementById('fin-exp-edit-fund');
  if (fund && r.funding_source) fund.value = r.funding_source;
  document.getElementById('dlg-fin-expense').showModal();
}

async function saveExpenseEdit() {
  const id = parseInt(document.getElementById('fin-exp-edit-id').value, 10);
  const amt = parseFloat(document.getElementById('fin-exp-edit-amt').value);
  if (!Number.isFinite(amt)) {
    showErr(new Error('Enter a valid amount.'));
    return;
  }
  const when = datetimeLocalToUtcNaive(document.getElementById('fin-exp-edit-when').value);
  if (!when) {
    showErr(new Error('Enter a valid date and time.'));
    return;
  }
  try {
    await api('updateExpense', pl({
      id,
      spent_at_utc: when,
      amount_cents: Math.round(amt * 100),
      currency: document.getElementById('fin-exp-edit-cur').value,
      description: document.getElementById('fin-exp-edit-desc').value.trim(),
      funding_source: document.getElementById('fin-exp-edit-fund').value
    }));
    document.getElementById('dlg-fin-expense').close();
    await loadFinanceMoney();
    if (state.navKey === 'Dashboard') await loadDashboard();
  } catch (e) {
    showErr(e);
  }
}

async function deleteExpenseEdit() {
  const id = parseInt(document.getElementById('fin-exp-edit-id').value, 10);
  if (!confirm('Delete this expense entry?')) return;
  try {
    await api('deleteExpense', pl({ id }));
    document.getElementById('dlg-fin-expense').close();
    await loadFinanceMoney();
    if (state.navKey === 'Dashboard') await loadDashboard();
  } catch (e) {
    showErr(e);
  }
}

async function loadFinanceMoney() {
  const bounds = await todayBounds();
  const inc = await api('listIncomeBetween', pl(bounds));
  const exp = await api('listExpensesBetween', pl(bounds));
  const ti = document.querySelector('#fin-income tbody');
  ti.innerHTML = '';
  for (const r of inc) {
    const tr = document.createElement('tr');
    const tWhen = document.createElement('td');
    tWhen.textContent = displayLocalTime(r.received_at_utc);
    const tAmt = document.createElement('td');
    tAmt.textContent = `${money(r.amount_cents)} ${r.currency || 'USD'}`;
    const tDesc = document.createElement('td');
    tDesc.textContent = r.description || '';
    const tAct = document.createElement('td');
    tAct.className = 'fin-actions';
    const bEd = document.createElement('button');
    bEd.type = 'button';
    bEd.textContent = 'Edit';
    bEd.addEventListener('click', () => openEditIncomeDialog(r));
    const bDel = document.createElement('button');
    bDel.type = 'button';
    bDel.className = 'danger';
    bDel.textContent = 'Delete';
    bDel.addEventListener('click', async () => {
      if (!confirm('Delete this income entry?')) return;
      try {
        await api('deleteIncome', pl({ id: r.id }));
        await loadFinanceMoney();
        if (state.navKey === 'Dashboard') await loadDashboard();
      } catch (e) {
        showErr(e);
      }
    });
    tAct.appendChild(bEd);
    tAct.appendChild(bDel);
    tr.appendChild(tWhen);
    tr.appendChild(tAmt);
    tr.appendChild(tDesc);
    tr.appendChild(tAct);
    ti.appendChild(tr);
  }
  const te = document.querySelector('#fin-expense tbody');
  te.innerHTML = '';
  for (const r of exp) {
    const tr = document.createElement('tr');
    const tWhen = document.createElement('td');
    tWhen.textContent = displayLocalTime(r.spent_at_utc);
    const tAmt = document.createElement('td');
    tAmt.textContent = `${money(r.amount_cents)} ${r.currency || 'USD'}`;
    const tDesc = document.createElement('td');
    tDesc.textContent = r.description || '';
    const tFund = document.createElement('td');
    tFund.textContent = r.funding_source || '';
    const tAct = document.createElement('td');
    tAct.className = 'fin-actions';
    const bEd = document.createElement('button');
    bEd.type = 'button';
    bEd.textContent = 'Edit';
    bEd.addEventListener('click', () => openEditExpenseDialog(r));
    const bDel = document.createElement('button');
    bDel.type = 'button';
    bDel.className = 'danger';
    bDel.textContent = 'Delete';
    bDel.addEventListener('click', async () => {
      if (!confirm('Delete this expense entry?')) return;
      try {
        await api('deleteExpense', pl({ id: r.id }));
        await loadFinanceMoney();
        if (state.navKey === 'Dashboard') await loadDashboard();
      } catch (e) {
        showErr(e);
      }
    });
    tAct.appendChild(bEd);
    tAct.appendChild(bDel);
    tr.appendChild(tWhen);
    tr.appendChild(tAmt);
    tr.appendChild(tDesc);
    tr.appendChild(tFund);
    tr.appendChild(tAct);
    te.appendChild(tr);
  }
}

function clearClientForm() {
  document.getElementById('cl-edit-id').value = '';
  document.getElementById('cl-name').value = '';
  document.getElementById('cl-co').value = '';
  document.getElementById('cl-email').value = '';
  document.getElementById('cl-phone').value = '';
  document.getElementById('cl-address').value = '';
  document.getElementById('cl-web').value = '';
  document.getElementById('cl-tax').value = '';
  document.getElementById('cl-notes').value = '';
  const b = document.getElementById('btn-save-client');
  if (b) b.textContent = 'Save client';
}

function fillClientForm(r) {
  document.getElementById('cl-edit-id').value = String(r.id);
  document.getElementById('cl-name').value = r.display_name || '';
  document.getElementById('cl-co').value = r.company || '';
  document.getElementById('cl-email').value = r.email || '';
  document.getElementById('cl-phone').value = r.phone || '';
  document.getElementById('cl-address').value = r.address || '';
  document.getElementById('cl-web').value = r.website || '';
  document.getElementById('cl-tax').value = r.tax_id || '';
  document.getElementById('cl-notes').value = r.notes || '';
  const b = document.getElementById('btn-save-client');
  if (b) b.textContent = 'Update client';
}

async function loadFinanceClients() {
  const rows = await api('listClients', pl({}));
  const tb = document.querySelector('#fin-clients tbody');
  tb.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.id}</td><td>${escapeHtml(r.display_name)}</td><td>${escapeHtml(r.company || '')}</td><td>${escapeHtml(
      r.email || ''
    )}</td><td></td>`;
    const td = tr.querySelector('td:last-child');
    td.className = 'fin-actions';
    const bEd = document.createElement('button');
    bEd.type = 'button';
    bEd.textContent = 'Edit';
    bEd.addEventListener('click', () => fillClientForm(r));
    const bArc = document.createElement('button');
    bArc.type = 'button';
    bArc.textContent = 'Archive';
    bArc.addEventListener('click', async () => {
      if (!confirm(`Archive client “${r.display_name || r.id}”? They will disappear from normal lists.`)) return;
      try {
        await api('archiveClient', pl({ client_id: r.id }));
        clearClientForm();
        await loadFinanceClients();
      } catch (e) {
        showErr(e);
      }
    });
    td.appendChild(bEd);
    td.appendChild(bArc);
    tb.appendChild(tr);
  }
}

async function loadFinanceInvoices() {
  const rows = await api('listInvoices', pl({ limit: 80 }));
  const tb = document.querySelector('#fin-invoices tbody');
  tb.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(r.invoice_number)}</td><td>${escapeHtml(r.status)}</td><td>${money(r.total_cents)} ${escapeHtml(
      r.currency
    )}</td><td>${escapeHtml(r.client_name || '')}</td><td>${escapeHtml(displayLocalTime(r.issued_at_utc))}</td><td></td>`;
    const td = tr.querySelector('td:last-child');
    td.className = 'fin-actions';
    const bOpen = document.createElement('button');
    bOpen.type = 'button';
    bOpen.textContent = 'Open';
    bOpen.addEventListener('click', () => {
      state.activeInvoiceId = r.id;
      document.getElementById('inv-line-edit-id').value = '';
      loadInvoiceDetail().catch(showErr);
    });
    const bDel = document.createElement('button');
    bDel.type = 'button';
    bDel.className = 'danger';
    bDel.textContent = 'Delete';
    bDel.addEventListener('click', async () => {
      if (!confirm(`Delete invoice ${r.invoice_number}? This cannot be undone.`)) return;
      try {
        await api('deleteInvoice', pl({ invoice_id: r.id }));
        if (state.activeInvoiceId === r.id) state.activeInvoiceId = null;
        await loadFinanceInvoices();
      } catch (e) {
        showErr(e);
      }
    });
    td.appendChild(bOpen);
    td.appendChild(bDel);
    tb.appendChild(tr);
  }
  if (state.activeInvoiceId) await loadInvoiceDetail();
}

function clearInvoiceLineForm() {
  document.getElementById('inv-line-edit-id').value = '';
  document.getElementById('inv-line-desc').value = '';
  document.getElementById('inv-line-qty').value = '1';
  document.getElementById('inv-line-unit').value = '';
}

async function loadInvoiceDetail() {
  const id = state.activeInvoiceId;
  if (!id) return;
  const inv = await api('getInvoice', pl({ invoice_id: id }));
  const lines = await api('listInvoiceLines', pl({ invoice_id: id }));
  document.getElementById('inv-active-id').textContent = String(id);
  document.getElementById('inv-active-num').textContent = inv ? inv.invoice_number || '' : '';
  const lt = document.querySelector('#fin-inv-lines tbody');
  lt.innerHTML = '';
  for (const ln of lines) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(ln.description)}</td><td>${ln.quantity}</td><td>${money(ln.unit_price_cents)}</td><td>${money(
      ln.line_total_cents
    )}</td><td></td>`;
    const td = tr.querySelector('td:last-child');
    td.className = 'fin-actions';
    const bEd = document.createElement('button');
    bEd.type = 'button';
    bEd.textContent = 'Edit';
    bEd.addEventListener('click', () => {
      document.getElementById('inv-line-edit-id').value = String(ln.id);
      document.getElementById('inv-line-desc').value = ln.description || '';
      document.getElementById('inv-line-qty').value = String(ln.quantity ?? 1);
      document.getElementById('inv-line-unit').value = String(ln.unit_price_cents ?? '');
    });
    const bDel = document.createElement('button');
    bDel.type = 'button';
    bDel.className = 'danger';
    bDel.textContent = 'Delete';
    bDel.addEventListener('click', async () => {
      if (!confirm('Remove this line from the invoice?')) return;
      try {
        await api('deleteInvoiceLine', pl({ invoice_id: id, line_id: ln.id }));
        clearInvoiceLineForm();
        await loadInvoiceDetail();
        await loadFinanceInvoices();
      } catch (e) {
        showErr(e);
      }
    });
    td.appendChild(bEd);
    td.appendChild(bDel);
    lt.appendChild(tr);
  }
}

function clearDebtForm() {
  document.getElementById('debt-edit-id').value = '';
  document.getElementById('debt-meta-status').value = '';
  document.getElementById('debt-meta-type').value = '';
  document.getElementById('debt-meta-ref').value = '';
  document.getElementById('debt-created').value = '';
  document.getElementById('debt-due').value = '';
  document.getElementById('debt-amt').value = '';
  document.getElementById('debt-cred').value = '';
  document.getElementById('debt-desc').value = '';
  const b = document.getElementById('btn-debt-save');
  if (b) b.textContent = 'Save debt';
}

function clearFundForm() {
  document.getElementById('fund-edit-id').value = '';
  document.getElementById('fund-name').value = '';
  document.getElementById('fund-bal').value = '';
  document.getElementById('fund-lim').value = '0';
  document.getElementById('fund-notes').value = '';
  const b = document.getElementById('btn-fund-save');
  if (b) b.textContent = 'Save account';
}

function clearSchxForm() {
  document.getElementById('schx-edit-id').value = '';
  document.getElementById('schx-meta-notes').value = '';
  document.getElementById('schx-meta-proj').value = '';
  document.getElementById('schx-meta-wc').value = '';
  document.getElementById('schx-meta-billable').value = '';
  document.getElementById('schx-desc').value = '';
  document.getElementById('schx-amt').value = '';
  document.getElementById('schx-due').value = '';
  const b = document.getElementById('btn-schx-save');
  if (b) b.textContent = 'Save scheduled';
}

function clearResForm() {
  document.getElementById('res-edit-id').value = '';
  document.getElementById('res-at').value = '';
  document.getElementById('res-amt').value = '';
  document.getElementById('res-desc').value = '';
  const b = document.getElementById('btn-res-save');
  if (b) b.textContent = 'Save entry';
}

async function loadFinanceDebts() {
  const rows = await api('listDebts', pl({ days: 365 }));
  const tb = document.querySelector('#fin-debts tbody');
  tb.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(r.description || '')}</td><td>${money(r.amount_cents)}</td><td>${escapeHtml(r.status)}</td><td>${escapeHtml(
      r.creditor || ''
    )}</td><td></td>`;
    const td = tr.querySelector('td:last-child');
    td.className = 'fin-actions';
    const bEd = document.createElement('button');
    bEd.type = 'button';
    bEd.textContent = 'Edit';
    bEd.addEventListener('click', () => {
      document.getElementById('debt-edit-id').value = String(r.id);
      document.getElementById('debt-meta-status').value = r.status || 'open';
      document.getElementById('debt-meta-type').value = r.debt_type || 'loan';
      document.getElementById('debt-meta-ref').value = r.account_ref || '';
      document.getElementById('debt-created').value = utcNaiveToDatetimeLocal(r.created_at_utc);
      document.getElementById('debt-due').value = r.due_at_utc ? utcNaiveToDatetimeLocal(r.due_at_utc) : '';
      document.getElementById('debt-amt').value = money(r.amount_cents);
      document.getElementById('debt-cur').value = r.currency || 'USD';
      document.getElementById('debt-cred').value = r.creditor || '';
      document.getElementById('debt-desc').value = r.description || '';
      const bs = document.getElementById('btn-debt-save');
      if (bs) bs.textContent = 'Update debt';
    });
    const bDel = document.createElement('button');
    bDel.type = 'button';
    bDel.className = 'danger';
    bDel.textContent = 'Delete';
    bDel.addEventListener('click', async () => {
      if (!confirm('Delete this debt record?')) return;
      try {
        await api('deleteDebtEntry', pl({ debt_id: r.id }));
        clearDebtForm();
        await loadFinanceDebts();
      } catch (e) {
        showErr(e);
      }
    });
    td.appendChild(bEd);
    td.appendChild(bDel);
    tb.appendChild(tr);
  }
}

async function loadFinanceFunds() {
  const rows = await api('listAvailableFundsAccounts', pl({}));
  const tb = document.querySelector('#fin-funds tbody');
  tb.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(r.account_name)}</td><td>${escapeHtml(r.account_type)}</td><td>${money(r.current_balance_cents)}</td><td>${escapeHtml(
      r.currency
    )}</td><td></td>`;
    const td = tr.querySelector('td:last-child');
    td.className = 'fin-actions';
    const bEd = document.createElement('button');
    bEd.type = 'button';
    bEd.textContent = 'Edit';
    bEd.addEventListener('click', () => {
      document.getElementById('fund-edit-id').value = String(r.id);
      document.getElementById('fund-name').value = r.account_name || '';
      document.getElementById('fund-type').value = r.account_type || 'cash';
      document.getElementById('fund-cur').value = r.currency || 'USD';
      document.getElementById('fund-bal').value = String(r.current_balance_cents ?? 0);
      document.getElementById('fund-lim').value = String(r.credit_limit_cents ?? 0);
      document.getElementById('fund-notes').value = r.notes || '';
      const bs = document.getElementById('btn-fund-save');
      if (bs) bs.textContent = 'Update account';
    });
    td.appendChild(bEd);
    tb.appendChild(tr);
  }
}

async function loadFinanceScheduled() {
  const rows = await api('listScheduledExpenses', pl({}));
  const tb = document.querySelector('#fin-scheduled tbody');
  tb.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(displayLocalTime(r.next_due_utc))}</td><td>${money(r.amount_cents)} ${escapeHtml(r.currency)}</td><td>${escapeHtml(
      r.description || ''
    )}</td><td>${escapeHtml(r.frequency)}</td><td></td>`;
    const td = tr.querySelector('td:last-child');
    td.className = 'fin-actions';
    const bEd = document.createElement('button');
    bEd.type = 'button';
    bEd.textContent = 'Edit';
    bEd.addEventListener('click', () => {
      document.getElementById('schx-edit-id').value = String(r.id);
      document.getElementById('schx-meta-notes').value = r.notes != null ? String(r.notes) : '';
      document.getElementById('schx-meta-proj').value = r.project_id != null ? String(r.project_id) : '';
      document.getElementById('schx-meta-wc').value = r.work_category_id != null ? String(r.work_category_id) : '';
      document.getElementById('schx-meta-billable').value = String(r.billable != null ? r.billable : 1);
      document.getElementById('schx-desc').value = r.description || '';
      document.getElementById('schx-amt').value = money(r.amount_cents);
      document.getElementById('schx-cur').value = r.currency || 'USD';
      document.getElementById('schx-freq').value = r.frequency || 'monthly';
      document.getElementById('schx-due').value = String(r.next_due_utc || '').trim();
      const bs = document.getElementById('btn-schx-save');
      if (bs) bs.textContent = 'Update scheduled';
    });
    const bDel = document.createElement('button');
    bDel.type = 'button';
    bDel.className = 'danger';
    bDel.textContent = 'Delete';
    bDel.addEventListener('click', async () => {
      if (!confirm('Delete this scheduled expense?')) return;
      try {
        await api('deleteScheduledExpense', pl({ scheduled_id: r.id }));
        clearSchxForm();
        await loadFinanceScheduled();
      } catch (e) {
        showErr(e);
      }
    });
    td.appendChild(bEd);
    td.appendChild(bDel);
    tb.appendChild(tr);
  }
}

async function loadFinanceResources() {
  const rows = await api('listResourceEntries', pl({ days: 365 }));
  const tb = document.querySelector('#fin-resources tbody');
  tb.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(displayLocalTime(r.at_utc))}</td><td>${money(r.amount_cents)} ${escapeHtml(r.currency)}</td><td>${escapeHtml(
      r.source_type || ''
    )}</td><td>${escapeHtml(r.description || '')}</td><td></td>`;
    const td = tr.querySelector('td:last-child');
    td.className = 'fin-actions';
    const bEd = document.createElement('button');
    bEd.type = 'button';
    bEd.textContent = 'Edit';
    bEd.addEventListener('click', () => {
      document.getElementById('res-edit-id').value = String(r.id);
      document.getElementById('res-at').value = utcNaiveToDatetimeLocal(r.at_utc);
      document.getElementById('res-amt').value = money(r.amount_cents);
      document.getElementById('res-cur').value = r.currency || 'USD';
      document.getElementById('res-src').value = r.source_type || 'owner_contribution';
      document.getElementById('res-desc').value = r.description || '';
      const bs = document.getElementById('btn-res-save');
      if (bs) bs.textContent = 'Update entry';
    });
    const bDel = document.createElement('button');
    bDel.type = 'button';
    bDel.className = 'danger';
    bDel.textContent = 'Delete';
    bDel.addEventListener('click', async () => {
      if (!confirm('Delete this resource entry?')) return;
      try {
        await api('deleteResourceEntry', pl({ id: r.id }));
        clearResForm();
        await loadFinanceResources();
      } catch (e) {
        showErr(e);
      }
    });
    td.appendChild(bEd);
    td.appendChild(bDel);
    tb.appendChild(tr);
  }
}

async function loadFinanceTax() {
  const y = new Date().getFullYear();
  const startUtc = `${y}-01-01T00:00:00`;
  const endUtc = `${y + 1}-01-01T00:00:00`;
  const m = await api('moneyTotalsByCurrencyBetween', pl({ startUtc, endUtc }));
  const el = document.getElementById('fin-tax-out');
  const lines = Object.entries(m).map(
    ([ccy, v]) => `${ccy}: income ${money(v.income_cents)} · expense ${money(v.expense_cents)} · net ${money(v.net_cents)}`
  );
  el.textContent = lines.length ? lines.join('\n') : 'No data in range.';
}

const NEW_PROJECT_OPTION_VALUE = '__new__';

function appendNewProjectOption(sel) {
  if (!sel || sel.id !== 'man-proj') return;
  const o = document.createElement('option');
  o.value = NEW_PROJECT_OPTION_VALUE;
  o.textContent = 'New project…';
  sel.appendChild(o);
}

function toggleTrackingNewProjectField() {
  const sel = document.getElementById('man-proj');
  const wrap = document.getElementById('man-proj-new-wrap');
  const cell = document.getElementById('tracking-project-cell');
  const grid = document.querySelector('#panel-Time-Tracking .tracking-fields-grid');
  const nameInp = document.getElementById('man-proj-new-name');
  if (!sel || !wrap) return;
  const show = sel.value === NEW_PROJECT_OPTION_VALUE;
  wrap.hidden = !show;
  if (grid) grid.classList.toggle('has-new-project', show);
  if (cell) cell.classList.toggle('tracking-project-has-new', show);
  if (show && nameInp) {
    nameInp.focus();
  }
}

/**
 * Returns numeric project id or null. If "New project…" is selected, creates the project first.
 * @throws {Error} missing new project name
 */
async function resolveTrackingProjectId() {
  const sel = document.getElementById('man-proj');
  if (!sel || sel.value === '') return null;
  if (sel.value !== NEW_PROJECT_OPTION_VALUE) {
    const n = parseInt(sel.value, 10);
    return Number.isFinite(n) ? n : null;
  }
  const nameEl = document.getElementById('man-proj-new-name');
  const name = nameEl ? nameEl.value.trim() : '';
  if (!name) {
    throw new Error('Enter a name for the new project, or choose an existing project.');
  }
  const cur = await api('insertProject', pl({ name, currency: 'USD' }));
  const newId = cur && cur.id != null ? cur.id : null;
  if (newId == null) throw new Error('Could not create project.');
  await fillCatProjSelectors();
  const sel2 = document.getElementById('man-proj');
  if (sel2) sel2.value = String(newId);
  if (nameEl) nameEl.value = '';
  const wrap = document.getElementById('man-proj-new-wrap');
  if (wrap) wrap.hidden = true;
  const cell = document.getElementById('tracking-project-cell');
  if (cell) cell.classList.remove('tracking-project-has-new');
  return parseInt(String(newId), 10);
}

/** When the category control was reset (no prior selection kept), match session or default to Development. */
function applyManCatFromState(cats, st) {
  const sel = document.getElementById('man-cat');
  if (!sel || !cats.length) return;
  const pref =
    st && st.current_work_category_id != null ? String(st.current_work_category_id) : null;
  if (pref && [...sel.options].some((o) => o.value === pref)) {
    sel.value = pref;
    return;
  }
  const development = cats.find((c) => c.name === 'Development');
  if (development && [...sel.options].some((o) => o.value === String(development.id))) {
    sel.value = String(development.id);
    return;
  }
  const fallback = cats.find((c) => c.name !== 'Evaluation');
  if (fallback && [...sel.options].some((o) => o.value === String(fallback.id))) {
    sel.value = String(fallback.id);
  }
}

async function fillCatProjSelectors(opts) {
  const cats = opts && opts.cats != null ? opts.cats : await api('listWorkCategories', pl({}));
  const projs = opts && opts.projs != null ? opts.projs : await api('listProjects', pl({}));
  let st = opts && opts.trackingState !== undefined ? opts.trackingState : undefined;
  if (st === undefined) {
    try {
      st = await api('trackingStateGet', pl({}));
    } catch (_) {
      st = null;
    }
  }

  function fill(sel, rows, labelKey, withEmpty) {
    if (!sel) return false;
    const keep = sel.value;
    sel.innerHTML = '';
    if (withEmpty) {
      const z = document.createElement('option');
      z.value = '';
      z.textContent = '—';
      sel.appendChild(z);
    }
    for (const x of rows) {
      const o = document.createElement('option');
      o.value = String(x.id);
      o.textContent = x[ labelKey ];
      sel.appendChild(o);
    }
    const restored = [...sel.options].some((o) => o.value === keep);
    if (restored) sel.value = keep;
    return restored;
  }

  const manProjSel = document.getElementById('man-proj');
  const keepProj = manProjSel ? manProjSel.value : '';

  const manCatRestored = fill(document.getElementById('man-cat'), cats, 'name', false);
  fill(document.getElementById('qa-cat'), cats, 'name', false);
  fill(manProjSel, projs, 'name', true);
  appendNewProjectOption(manProjSel);
  if (
    keepProj === NEW_PROJECT_OPTION_VALUE &&
    manProjSel &&
    [...manProjSel.options].some((o) => o.value === NEW_PROJECT_OPTION_VALUE)
  ) {
    manProjSel.value = NEW_PROJECT_OPTION_VALUE;
  }
  toggleTrackingNewProjectField();

  fill(document.getElementById('qa-proj'), projs, 'name', true);

  if (!manCatRestored) applyManCatFromState(cats, st);
  return { cats, projs };
}

async function loadTimeTracking() {
  let st = null;
  try {
    st = await api('trackingStateGet', pl({}));
  } catch (_) {
    /* filled below */
  }
  let cats = [];
  let projs = [];
  try {
    ({ cats, projs } = await fillCatProjSelectors({ trackingState: st }));
  } catch (e) {
    showErr(e);
    return;
  }
  const categoryById = Object.fromEntries(cats.map((c) => [c.id, c.name]));
  const projectById = Object.fromEntries(projs.map((p) => [p.id, p.name]));
  try {
    renderTrackingStatePanel(st, categoryById, projectById);
  } catch (e) {
    const t = document.getElementById('time-status');
    if (t) t.textContent = 'Could not load your current session. ' + (e && e.message ? e.message : String(e));
  }
  const ctb = document.querySelector('#tbl-categories tbody');
  ctb.innerHTML = '';
  for (const c of cats) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(c.name)}</td><td>${c.billable ? 'yes' : 'no'}</td><td></td>`;
    const td = tr.querySelector('td:last-child');
    td.className = 'fin-actions';
    const bEd = document.createElement('button');
    bEd.type = 'button';
    bEd.textContent = 'Edit';
    bEd.addEventListener('click', () => {
      document.getElementById('cat-edit-id').value = String(c.id);
      document.getElementById('cat-name').value = c.name || '';
      document.getElementById('cat-color').value = c.color || '#2B8A8F';
      document.getElementById('cat-bill').value = c.billable ? '1' : '0';
      const bs = document.getElementById('btn-save-cat');
      if (bs) bs.textContent = 'Update category';
    });
    const bArc = document.createElement('button');
    bArc.type = 'button';
    bArc.textContent = 'Archive';
    bArc.addEventListener('click', async () => {
      if (!confirm(`Archive category “${c.name}”?`)) return;
      try {
        await api('archiveWorkCategory', pl({ category_id: c.id }));
        document.getElementById('cat-edit-id').value = '';
        await loadTimeTracking();
      } catch (e) {
        showErr(e);
      }
    });
    td.appendChild(bEd);
    td.appendChild(bArc);
    ctb.appendChild(tr);
  }
  const ptb = document.querySelector('#tbl-projects tbody');
  ptb.innerHTML = '';
  for (const pr of projs) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(pr.name)}</td><td>${escapeHtml(pr.client_name || '')}</td><td></td>`;
    const td = tr.querySelector('td:last-child');
    td.className = 'fin-actions';
    const bEd = document.createElement('button');
    bEd.type = 'button';
    bEd.textContent = 'Edit';
    bEd.addEventListener('click', () => {
      document.getElementById('proj-edit-id').value = String(pr.id);
      document.getElementById('proj-name').value = pr.name || '';
      document.getElementById('proj-client').value = pr.client_name || '';
      document.getElementById('proj-cur').value = pr.currency || 'USD';
      const bs = document.getElementById('btn-save-proj');
      if (bs) bs.textContent = 'Update project';
    });
    const bArc = document.createElement('button');
    bArc.type = 'button';
    bArc.textContent = 'Archive';
    bArc.addEventListener('click', async () => {
      if (!confirm(`Archive project “${pr.name}”?`)) return;
      try {
        await api('archiveProject', pl({ project_id: pr.id }));
        document.getElementById('proj-edit-id').value = '';
        await loadTimeTracking();
      } catch (e) {
        showErr(e);
      }
    });
    td.appendChild(bEd);
    td.appendChild(bArc);
    ptb.appendChild(tr);
  }

  const qa = await api('listQuickActions', pl({}));
  const qtb = document.querySelector('#tbl-quick tbody');
  qtb.innerHTML = '';
  for (const q of qa) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(q.label)}</td><td>${q.work_category_id || ''}</td><td>${q.project_id || ''}</td><td></td>`;
    const td = tr.querySelector('td:last-child');
    td.className = 'fin-actions';
    const bEd = document.createElement('button');
    bEd.type = 'button';
    bEd.textContent = 'Edit';
    bEd.addEventListener('click', async () => {
      await fillCatProjSelectors({});
      document.getElementById('qa-edit-id').value = String(q.id);
      document.getElementById('qa-label').value = q.label || '';
      document.getElementById('qa-desc').value = q.default_description || '';
      const qc = document.getElementById('qa-cat');
      const qp = document.getElementById('qa-proj');
      if (qc && q.work_category_id != null) qc.value = String(q.work_category_id);
      if (qp && q.project_id != null) qp.value = String(q.project_id);
      const bs = document.getElementById('btn-save-qa');
      if (bs) bs.textContent = 'Update quick action';
    });
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'Delete';
    b.addEventListener('click', async () => {
      await api('deleteQuickAction', pl({ id: q.id }));
      loadTimeTracking();
    });
    td.appendChild(bEd);
    td.appendChild(b);
    qtb.appendChild(tr);
  }
}

function clearScheduleForm() {
  document.getElementById('ev-edit-id').value = '';
  document.getElementById('ev-title').value = '';
  document.getElementById('ev-start').value = '';
  document.getElementById('ev-end').value = '';
  document.getElementById('ev-status').value = 'scheduled';
  document.getElementById('ev-client').value = '';
  document.getElementById('ev-proj').value = '';
  document.getElementById('ev-notes').value = '';
  const bs = document.getElementById('btn-ev-save');
  if (bs) bs.textContent = 'Save event';
}

async function loadSchedule() {
  const t0 = new Date();
  const t1 = new Date();
  t1.setDate(t1.getDate() + 90);
  const b = await api(
    'localReportRangeBounds',
    pl({
      sy: t0.getFullYear(),
      sm: t0.getMonth() + 1,
      sd: t0.getDate(),
      ey: t1.getFullYear(),
      em: t1.getMonth() + 1,
      ed: t1.getDate()
    })
  );
  const rows = await api('listScheduleBetween', pl({ startUtc: b.startUtc, endUtc: b.endUtc }));
  const tb = document.querySelector('#sched-table tbody');
  tb.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(r.title)}</td><td>${escapeHtml(displayLocalTime(r.starts_at_utc))}</td><td>${escapeHtml(r.client_name || '')}</td><td>${escapeHtml(
      r.status
    )}</td><td></td>`;
    const td = tr.querySelector('td:last-child');
    td.className = 'fin-actions';
    const bEd = document.createElement('button');
    bEd.type = 'button';
    bEd.textContent = 'Edit';
    bEd.addEventListener('click', () => {
      document.getElementById('ev-edit-id').value = String(r.id);
      document.getElementById('ev-title').value = r.title || '';
      document.getElementById('ev-start').value = utcNaiveToDatetimeLocal(r.starts_at_utc);
      document.getElementById('ev-end').value = r.ends_at_utc ? utcNaiveToDatetimeLocal(r.ends_at_utc) : '';
      document.getElementById('ev-status').value = r.status || 'scheduled';
      document.getElementById('ev-client').value = r.client_id != null ? String(r.client_id) : '';
      document.getElementById('ev-proj').value = r.project_id != null ? String(r.project_id) : '';
      document.getElementById('ev-notes').value = r.notes || '';
      const bs = document.getElementById('btn-ev-save');
      if (bs) bs.textContent = 'Update event';
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      await api('deleteScheduleEvent', pl({ event_id: r.id }));
      clearScheduleForm();
      loadSchedule();
    });
    td.appendChild(bEd);
    td.appendChild(del);
    tb.appendChild(tr);
  }
}

function clearStockProductForm() {
  document.getElementById('st-edit-id').value = '';
  document.getElementById('st-name').value = '';
  document.getElementById('st-sku').value = '';
  document.getElementById('st-qty').value = '';
  document.getElementById('st-reorder').value = '';
  document.getElementById('st-unit').value = 'ea';
  document.getElementById('st-cost').value = '';
  document.getElementById('st-price').value = '';
  document.getElementById('st-notes').value = '';
  const bs = document.getElementById('btn-st-save');
  if (bs) bs.textContent = 'Save product';
}

function clearSupplyForm() {
  document.getElementById('su-edit-id').value = '';
  document.getElementById('su-name').value = '';
  document.getElementById('su-qty').value = '';
  document.getElementById('su-reorder').value = '';
  document.getElementById('su-unit').value = 'ea';
  document.getElementById('su-cat').value = '';
  document.getElementById('su-vendor').value = '';
  document.getElementById('su-notes').value = '';
  const bs = document.getElementById('btn-su-save');
  if (bs) bs.textContent = 'Save supply';
}

async function loadStock() {
  const p = await api('listStockProducts', pl({}));
  const s = await api('listSupplies', pl({}));
  const tp = document.querySelector('#stock-products tbody');
  tp.innerHTML = '';
  for (const r of p) {
    const tr = document.createElement('tr');
    const id = r.id;
    tr.innerHTML = `<td>${escapeHtml(r.name)}</td><td>${r.qty_on_hand}</td><td>${r.reorder_level}</td><td>${escapeHtml(
      r.unit
    )}</td><td><input type="number" class="inp-stk-d" data-stk="${id}" step="0.01" style="width: 80px" /></td><td></td>`;
    const td = tr.querySelector('td:last-child');
    td.className = 'fin-actions';
    const bAdj = document.createElement('button');
    bAdj.type = 'button';
    bAdj.textContent = 'Δ';
    bAdj.title = 'Apply quantity change';
    bAdj.addEventListener('click', async () => {
      const inp = tr.querySelector(`input[data-stk="${id}"]`);
      const delta = parseFloat(inp.value);
      if (Number.isNaN(delta)) return;
      await api('adjustStockQty', pl({ product_id: id, delta }));
      loadStock();
    });
    const bEd = document.createElement('button');
    bEd.type = 'button';
    bEd.textContent = 'Edit';
    bEd.addEventListener('click', () => {
      document.getElementById('st-edit-id').value = String(r.id);
      document.getElementById('st-name').value = r.name || '';
      document.getElementById('st-sku').value = r.sku || '';
      document.getElementById('st-qty').value = r.qty_on_hand != null ? String(r.qty_on_hand) : '';
      document.getElementById('st-reorder').value = r.reorder_level != null ? String(r.reorder_level) : '';
      document.getElementById('st-unit').value = r.unit || 'ea';
      document.getElementById('st-cost').value = r.unit_cost_cents != null ? String(r.unit_cost_cents) : '';
      document.getElementById('st-price').value = r.unit_price_cents != null ? String(r.unit_price_cents) : '';
      document.getElementById('st-notes').value = r.notes || '';
      const bs = document.getElementById('btn-st-save');
      if (bs) bs.textContent = 'Update product';
    });
    const bArc = document.createElement('button');
    bArc.type = 'button';
    bArc.textContent = 'Archive';
    bArc.addEventListener('click', async () => {
      if (!confirm(`Archive product “${r.name}”?`)) return;
      try {
        await api('saveStockProduct', pl({
          product_id: id,
          name: r.name,
          sku: r.sku,
          description: r.description,
          unit: r.unit || 'ea',
          qty_on_hand: r.qty_on_hand,
          reorder_level: r.reorder_level,
          unit_cost_cents: r.unit_cost_cents,
          unit_price_cents: r.unit_price_cents,
          currency: r.currency || 'USD',
          notes: r.notes,
          archived: true
        }));
        clearStockProductForm();
        loadStock();
      } catch (e) {
        showErr(e);
      }
    });
    td.appendChild(bAdj);
    td.appendChild(bEd);
    td.appendChild(bArc);
    tp.appendChild(tr);
  }

  const ts = document.querySelector('#stock-supplies tbody');
  ts.innerHTML = '';
  for (const r of s) {
    const tr = document.createElement('tr');
    const id = r.id;
    tr.innerHTML = `<td>${escapeHtml(r.name)}</td><td>${r.qty_on_hand}</td><td>${escapeHtml(r.category || '')}</td><td><input type="number" class="inp-su-d" data-su="${id}" step="0.01" style="width: 80px" /></td><td></td>`;
    const td = tr.querySelector('td:last-child');
    td.className = 'fin-actions';
    const bAdj = document.createElement('button');
    bAdj.type = 'button';
    bAdj.textContent = 'Δ';
    bAdj.title = 'Apply quantity change';
    bAdj.addEventListener('click', async () => {
      const inp = tr.querySelector(`input[data-su="${id}"]`);
      const delta = parseFloat(inp.value);
      if (Number.isNaN(delta)) return;
      await api('adjustSupplyQty', pl({ supply_id: id, delta }));
      loadStock();
    });
    const bEd = document.createElement('button');
    bEd.type = 'button';
    bEd.textContent = 'Edit';
    bEd.addEventListener('click', () => {
      document.getElementById('su-edit-id').value = String(r.id);
      document.getElementById('su-name').value = r.name || '';
      document.getElementById('su-qty').value = r.qty_on_hand != null ? String(r.qty_on_hand) : '';
      document.getElementById('su-reorder').value = r.reorder_level != null ? String(r.reorder_level) : '';
      document.getElementById('su-unit').value = r.unit || 'ea';
      document.getElementById('su-cat').value = r.category || '';
      document.getElementById('su-vendor').value = r.vendor || '';
      document.getElementById('su-notes').value = r.notes || '';
      const bs = document.getElementById('btn-su-save');
      if (bs) bs.textContent = 'Update supply';
    });
    const bArc = document.createElement('button');
    bArc.type = 'button';
    bArc.textContent = 'Archive';
    bArc.addEventListener('click', async () => {
      if (!confirm(`Archive supply “${r.name}”?`)) return;
      try {
        await api('saveSupply', pl({
          supply_id: id,
          name: r.name,
          category: r.category,
          unit: r.unit || 'ea',
          qty_on_hand: r.qty_on_hand,
          reorder_level: r.reorder_level,
          vendor: r.vendor,
          notes: r.notes,
          archived: true
        }));
        clearSupplyForm();
        loadStock();
      } catch (e) {
        showErr(e);
      }
    });
    td.appendChild(bAdj);
    td.appendChild(bEd);
    td.appendChild(bArc);
    ts.appendChild(tr);
  }
}

function openWorklogEditDialog(row) {
  document.getElementById('wl-edit-id').value = String(row.id);
  document.getElementById('wl-edit-type').value = row.event_type || '';
  document.getElementById('wl-edit-detail').value = row.detail || '';
  document.getElementById('wl-edit-time').value = utcNaiveToDatetimeLocal(row.created_at_utc);
  document.getElementById('dlg-worklog-edit').showModal();
}

function closeWorklogEditDialog() {
  document.getElementById('dlg-worklog-edit').close();
}

async function saveWorklogEdit() {
  const id = parseInt(document.getElementById('wl-edit-id').value, 10);
  const event_type = document.getElementById('wl-edit-type').value.trim();
  const detail = document.getElementById('wl-edit-detail').value;
  const created_at_utc = datetimeLocalToUtcNaive(document.getElementById('wl-edit-time').value);
  if (!created_at_utc) {
    showErr(new Error('Enter a valid date and time.'));
    return;
  }
  if (!event_type) {
    showErr(new Error('Event type is required.'));
    return;
  }
  try {
    await api('updateSessionEvent', pl({ id, event_type, detail, created_at_utc }));
    closeWorklogEditDialog();
    await loadWorkLog();
    await loadTimeTracking();
  } catch (e) {
    showErr(e);
  }
}

async function deleteWorklogRow(id) {
  if (!confirm('Delete this work log entry?')) return;
  try {
    await api('deleteSessionEvent', pl({ id }));
    await loadWorkLog();
    await loadTimeTracking();
  } catch (e) {
    showErr(e);
  }
}

async function fillWlTeSelectors(row) {
  const catsRaw = await api('listWorkCategories', pl({ includeArchived: true }));
  const catsAll = Array.isArray(catsRaw) ? catsRaw : [];
  const cats = catsAll.filter(isTimeEntryWorkCategoryOption);
  const projs = await api('listProjects', pl({ includeArchived: true }));
  const catSel = document.getElementById('wl-te-cat');
  const projSel = document.getElementById('wl-te-proj');
  if (!catSel || !projSel) return;
  catSel.innerHTML = '';
  for (const x of cats) {
    const o = document.createElement('option');
    o.value = String(x.id);
    o.textContent = x.name;
    catSel.appendChild(o);
  }
  const wid = row.work_category_id != null ? String(row.work_category_id) : '';
  if (wid && ![...catSel.options].some((o) => o.value === wid)) {
    const orphan = catsAll.find((c) => String(c.id) === wid);
    const o = document.createElement('option');
    o.value = wid;
    o.textContent = orphan && orphan.name ? String(orphan.name) : `Category ${wid}`;
    catSel.appendChild(o);
  }
  projSel.innerHTML = '';
  const z = document.createElement('option');
  z.value = '';
  z.textContent = '—';
  projSel.appendChild(z);
  const projRows = Array.isArray(projs) ? projs : [];
  for (const x of projRows) {
    const o = document.createElement('option');
    o.value = String(x.id);
    o.textContent = x.name;
    projSel.appendChild(o);
  }
  if (wid && [...catSel.options].some((o) => o.value === wid)) {
    catSel.value = wid;
  }
  if (row.project_id != null && [...projSel.options].some((o) => o.value === String(row.project_id))) {
    projSel.value = String(row.project_id);
  }
}

async function openTimeEntryEditDialog(row) {
  document.getElementById('wl-te-entry-id').value = String(row.id);
  document.getElementById('wl-te-start').value = utcNaiveToDatetimeLocal(row.start_utc);
  document.getElementById('wl-te-end').value = utcNaiveToDatetimeLocal(row.end_utc);
  document.getElementById('wl-te-desc').value = row.description || '';
  try {
    await fillWlTeSelectors(row);
    document.getElementById('dlg-time-entry-edit').showModal();
  } catch (e) {
    showErr(e);
  }
}

async function saveTimeEntryEdit() {
  const id = parseInt(document.getElementById('wl-te-entry-id').value, 10);
  const start = datetimeLocalToUtcNaive(document.getElementById('wl-te-start').value);
  const end = datetimeLocalToUtcNaive(document.getElementById('wl-te-end').value);
  if (!start || !end) {
    showErr(new Error('Enter valid start and end times.'));
    return;
  }
  const wc = document.getElementById('wl-te-cat').value;
  const pj = document.getElementById('wl-te-proj').value;
  try {
    await api('updateTimeEntry', pl({
      entry_id: id,
      start_utc: start,
      end_utc: end,
      description: document.getElementById('wl-te-desc').value,
      work_category_id: wc ? parseInt(wc, 10) : null,
      project_id: pj ? parseInt(pj, 10) : null
    }));
    document.getElementById('dlg-time-entry-edit').close();
    await loadWorkLog();
    if (state.navKey === 'Reports' && hasProPlan()) await loadReports();
    if (state.navKey === 'Dashboard') await loadDashboard();
  } catch (e) {
    showErr(e);
  }
}

async function deleteTimeEntryFromDialog() {
  const id = parseInt(document.getElementById('wl-te-entry-id').value, 10);
  if (!confirm('Delete this tracked time block?')) return;
  try {
    await api('deleteTimeEntry', pl({ entry_id: id }));
    document.getElementById('dlg-time-entry-edit').close();
    await loadWorkLog();
    if (state.navKey === 'Reports' && hasProPlan()) await loadReports();
    if (state.navKey === 'Dashboard') await loadDashboard();
  } catch (e) {
    showErr(e);
  }
}

function openWorklogBulkDialog() {
  const ids = getSelectedWorklogSessionIds();
  if (!ids.length) return;
  const intro = document.getElementById('wl-bulk-intro');
  if (intro) intro.textContent = `${ids.length} session marker(s) selected.`;
  document.getElementById('wl-bulk-do-type').checked = false;
  document.getElementById('wl-bulk-do-detail').checked = false;
  document.getElementById('wl-bulk-type').value = '';
  document.getElementById('wl-bulk-detail').value = '';
  document.getElementById('wl-bulk-type').disabled = true;
  document.getElementById('wl-bulk-detail').disabled = true;
  document.getElementById('dlg-worklog-bulk').showModal();
}

async function applyWorklogBulkEdit() {
  const ids = getSelectedWorklogSessionIds();
  if (!ids.length) return;
  const doType = document.getElementById('wl-bulk-do-type').checked;
  const doDetail = document.getElementById('wl-bulk-do-detail').checked;
  if (!doType && !doDetail) {
    showErr(new Error('Turn on “Change event type” and/or “Change detail text”, then fill in the new values.'));
    return;
  }
  const payload = { ids };
  if (doType) payload.event_type = document.getElementById('wl-bulk-type').value.trim();
  if (doDetail) payload.detail = document.getElementById('wl-bulk-detail').value;
  if (doType && !payload.event_type) {
    showErr(new Error('Enter an event type, or turn off “Change event type”.'));
    return;
  }
  try {
    await api('bulkUpdateSessionEvents', pl(payload));
    document.getElementById('dlg-worklog-bulk').close();
    await loadWorkLog();
    await loadTimeTracking();
  } catch (e) {
    showErr(e);
  }
}

async function bulkDeleteWorklog() {
  const sel = getSelectedWorklogSelection();
  if (!sel.length) return;
  if (!confirm(`Delete ${sel.length} selected row(s)? This cannot be undone.`)) return;
  try {
    const sessionIds = sel.filter((x) => x.kind === 'session').map((x) => x.id);
    const timeIds = sel.filter((x) => x.kind === 'time').map((x) => x.id);
    if (sessionIds.length) await api('deleteSessionEvents', pl({ ids: sessionIds }));
    for (const id of timeIds) {
      await api('deleteTimeEntry', pl({ entry_id: id }));
    }
    await loadWorkLog();
    await loadTimeTracking();
  } catch (e) {
    showErr(e);
  }
}

async function loadWorkLog() {
  initWorkLogDateDefaults();
  const ws = document.getElementById('wl-start');
  const we = document.getElementById('wl-end');
  const rs = ws && ws.value;
  const re = we && we.value;
  if (!rs || !re) {
    worklogMergedCache = [];
    const tbEmpty = document.querySelector('#worklog-table tbody');
    if (tbEmpty) tbEmpty.innerHTML = '';
    updateWorklogBulkButtons();
    return;
  }
  const [sy, sm, sd] = rs.split('-').map((x) => parseInt(x, 10));
  const [ey, em, ed] = re.split('-').map((x) => parseInt(x, 10));
  let b;
  try {
    b = await api('localReportRangeBounds', pl({ sy, sm, sd, ey, em, ed }));
  } catch (e) {
    showErr(e);
    return;
  }
  const hint = document.getElementById('wl-range-hint');
  if (hint) hint.textContent = `Period: ${displayLocalTime(b.startUtc)} → ${displayLocalTime(b.endUtc)}`;
  let sessions;
  let timeEntries;
  let catsRaw;
  try {
    [sessions, timeEntries, catsRaw] = await Promise.all([
      api('listSessionEventsBetween', pl(b)),
      api('listTimeEntriesBetween', pl(b)),
      api('listWorkCategories', pl({ includeArchived: true }))
    ]);
  } catch (e) {
    showErr(e);
    return;
  }
  const catsList = Array.isArray(catsRaw) ? catsRaw : [];
  const merged = [];
  for (const r of sessions) {
    merged.push({ kind: 'session', sort: String(r.created_at_utc || ''), row: r });
  }
  for (const r of timeEntries) {
    merged.push({ kind: 'time', sort: String(r.start_utc || ''), row: r });
  }
  merged.sort((a, b) => a.sort.localeCompare(b.sort));
  worklogMergedCache = merged;
  populateWorklogCategoryFilterSelect(catsList.filter(isTimeEntryWorkCategoryOption));
  applyWorklogFilters();
}

function downloadPdfBase64(filename, base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * Download a printable PDF: Dashboard Combined totals for Day, Week, Month, and Year
 * (same data as `getDashboardSummary` with segmentIndex 0), using the Dashboard breakdown mode.
 */
async function generateReportsSummaryPdf() {
  applyReportsPlanLock();
  if (!hasProPlan()) return;
  const bdEl = document.getElementById('dash-bd-mode');
  const breakdownMode = bdEl && bdEl.value === 'Project' ? 'Project' : 'Category';
  const scales = ['Daily', 'Weekly', 'Monthly', 'Yearly'];
  const sections = [];
  try {
    for (const scale of scales) {
      const data = await api(
        'getDashboardSummary',
        pl({
          scale,
          breakdownMode,
          segmentIndex: 0,
          customDay: null,
          includeAvailableFunds: true
        })
      );
      sections.push({
        scale,
        windowLabel: data.window && data.window.label != null ? String(data.window.label) : '',
        scopeLabel: data.periodCardLabel != null ? String(data.periodCardLabel) : '',
        comparePrevLabel: data.comparePrevLabel != null ? String(data.comparePrevLabel) : '',
        summary: data.summary,
        previousSummary: data.previousSummary,
        breakdownMode: data.breakdownMode || breakdownMode,
        breakdown: data.breakdown || [],
        moneyByCurrency: data.moneyByCurrency || {},
        availableFundsTotals: data.availableFundsTotals || null
      });
    }
    const generatedAt = formatWithAppWallClock(new Date(), { dateStyle: 'medium', timeStyle: 'short' });
    const base64 = rootRecord.buildDashboardSummaryPdfBase64({
      title: 'Root Record — dashboard summary',
      generatedAt,
      sections
    });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const filename = `RootRecord-summary-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.pdf`;
    downloadPdfBase64(filename, base64);
  } catch (e) {
    showErr(e);
  }
}

async function loadReports() {
  applyReportsPlanLock();
  if (!hasProPlan()) return;
  initReportDateDefaults();
  const rs = document.getElementById('rep-start').value;
  const re = document.getElementById('rep-end').value;
  if (!rs || !re) return;
  const [sy, sm, sd] = rs.split('-').map((x) => parseInt(x, 10));
  const [ey, em, ed] = re.split('-').map((x) => parseInt(x, 10));
  const b = await api('localReportRangeBounds', pl({ sy, sm, sd, ey, em, ed }));
  document.getElementById('rep-bounds').textContent = `Period: ${displayLocalTime(b.startUtc)} → ${displayLocalTime(b.endUtc)}`;
  const entries = await api('listTimeEntriesBetween', pl(b));
  const tb = document.querySelector('#rep-entries tbody');
  tb.innerHTML = '';
  for (const r of entries) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(displayLocalTime(r.start_utc))}</td><td>${escapeHtml(displayLocalTime(r.end_utc))}</td><td>${escapeHtml(
      r.category_name || ''
    )}</td><td>${escapeHtml(r.description || '')}</td><td></td>`;
    const td = tr.querySelector('td:last-child');
    td.className = 'fin-actions';
    const bEd = document.createElement('button');
    bEd.type = 'button';
    bEd.textContent = 'Edit';
    bEd.addEventListener('click', () => openTimeEntryEditDialog(r));
    const bDel = document.createElement('button');
    bDel.type = 'button';
    bDel.className = 'danger';
    bDel.textContent = 'Delete';
    bDel.addEventListener('click', async () => {
      if (!confirm('Delete this tracked time entry?')) return;
      try {
        await api('deleteTimeEntry', pl({ entry_id: r.id }));
        await loadReports();
      } catch (e) {
        showErr(e);
      }
    });
    td.appendChild(bEd);
    td.appendChild(bDel);
    tb.appendChild(tr);
  }
  const breakdown = await api('dailyTaskBreakdown', pl(b));
  renderPieBar('rep-pie', 'rep-bar', breakdown, 'rep');
}

function formatSyncStatusMessage(r) {
  const pushed = r.pushed ?? 0;
  const pulled = r.pulled ?? 0;
  const applied = r.applied ?? 0;
  const dbPath = r.localDbPath || state.dbPath || '';
  const dbBit = dbPath ? ` Local file: ${dbPath}` : '';
  const head = `Done. Uploaded ${pushed}, downloaded ${pulled}, merged ${applied}.`;
  if (!r.syncConfigured) {
    const why = !r.hasSessionToken
      ? 'Sign in under Membership so the app can call the sync API.'
      : !r.hasApiBaseUrl
        ? 'License API base URL is missing (unusual in a normal build).'
        : 'Sync is not ready.';
    return `${head} ${why} Your work still saves to SQLite on this PC.${dbBit}`;
  }
  if ((r.pendingOutbox ?? 0) > 0 && pushed === 0) {
    const err = r.lastSyncError ? ` Last server error on a failed row: ${r.lastSyncError}` : '';
    return `${head} ${r.pendingOutbox} change(s) are still queued (upload did not clear the queue). Try signing in again or check the network.${err}${dbBit}`;
  }
  if (pushed === 0 && pulled === 0 && applied === 0) {
    let tail = ' Nothing new from the server and nothing pending to send (or the queue was already empty).';
    if (r.lastSyncError) {
      tail += ` Earlier failures in the queue: ${r.lastSyncError}`;
    }
    return `${head}${tail}${dbBit}`;
  }
  return `${head}${dbBit}`;
}

async function onSyncNow() {
  const st = document.getElementById('acct-sync-status');
  const b1 = document.getElementById('btn-sync-now');
  const b2 = document.getElementById('btn-sync-reupload');
  if (isGuestLocalLicense()) {
    if (st) {
      st.textContent =
        'Cloud sync requires a Root Record sign-in. You are in local-only mode until you sign in.';
    }
    return;
  }
  if (st) st.textContent = 'Syncing…';
  if (b1) b1.disabled = true;
  if (b2) b2.disabled = true;
  try {
    const r = await rootRecord.syncRun();
    if (st) {
      st.textContent = formatSyncStatusMessage(r);
    }
  } catch (e) {
    showErr(e);
    if (st) st.textContent = '';
  } finally {
    if (b1) b1.disabled = false;
    if (b2) b2.disabled = false;
  }
}

async function onSyncReuploadHistory() {
  const st = document.getElementById('acct-sync-status');
  const b1 = document.getElementById('btn-sync-now');
  const b2 = document.getElementById('btn-sync-reupload');
  if (isGuestLocalLicense()) {
    if (st) {
      st.textContent =
        'Cloud sync requires a Root Record sign-in. You are in local-only mode until you sign in.';
    }
    return;
  }
  if (st) st.textContent = 'Re-queuing local history and syncing…';
  if (b1) b1.disabled = true;
  if (b2) b2.disabled = true;
  try {
    const r = await rootRecord.syncReuploadHistory();
    if (st) {
      st.textContent = formatSyncStatusMessage(r);
    }
  } catch (e) {
    showErr(e);
    if (st) st.textContent = '';
  } finally {
    if (b1) b1.disabled = false;
    if (b2) b2.disabled = false;
  }
}

async function loadAccount() {
  const st = document.getElementById('acct-reset-status');
  if (st) st.textContent = '';
  const pathEl = document.getElementById('acct-db-path');
  if (pathEl) pathEl.textContent = state.dbPath || '—';
  const uidEl = document.getElementById('acct-user-id');
  if (uidEl) uidEl.textContent = state.userId != null ? String(state.userId) : '—';

  try {
    const snap = await rootRecord.licensePrepare({ forceRefresh: true });
    if (snap && snap.proPaymentLinkBase) {
      state.proPaymentLinkBase = String(snap.proPaymentLinkBase);
    }
    if (snap && snap.authenticated) state.license = snap;
  } catch (_) {
    /* keep prior state.license */
  }
  syncGuestModeBanner();
  const lic = state.license || {};
  const mailEl = document.getElementById('acct-license-email');
  const memEl = document.getElementById('acct-membership');
  const detEl = document.getElementById('acct-license-detail');
  if (mailEl) mailEl.textContent = lic.email || '—';
  if (memEl) memEl.textContent = lic.membershipLabel || '—';
  if (detEl) {
    const bits = [];
    if (lic.guestLocal) {
      bits.push(
        'You opened Business Manager without a saved Root Record account. The sign-in screen appears on every launch until you sign in. Account-based sync and online features stay unavailable until then.'
      );
    } else if (lic.proUnlocked) {
      bits.push('Pro: advanced Reports, multi-business, and upcoming cloud backup / AI reports as they ship.');
    } else if (lic.access === 'read_only') {
      bits.push('Subscription needs attention; editing may be limited.');
    } else {
      bits.push('Free tier: full local tools; Reports workspace and multi-business require Pro.');
    }
    if (lic.validUntil) bits.push(`Current access through: ${displayLocalTime(lic.validUntil)}.`);
    if (lic.offlineGrace) bits.push('Signed in offline using your last subscription check.');
    detEl.textContent = bits.join(' ');
  }

  applyReportsPlanLock();
  let mbSet = false;
  try {
    mbSet = await api('settingGet', pl({ key: 'multi_business_enabled', default: false }));
  } catch (_) {
    mbSet = false;
  }
  applyBusinessPlanUi(hasProPlan(), mbSet);
  refreshProUpgradeButtonVisibility();
}

/** Open Stripe Payment Link in the system browser (same as classic `license_config` / `get_payment_link_url`). */
async function openProUpgradeInBrowser() {
  let base = (state.proPaymentLinkBase || (state.license && state.license.proPaymentLinkBase) || '').trim();
  if (!base) {
    try {
      const snap = await rootRecord.licensePrepare();
      if (snap && snap.proPaymentLinkBase) {
        state.proPaymentLinkBase = String(snap.proPaymentLinkBase);
        base = state.proPaymentLinkBase.trim();
      }
    } catch (e) {
      showErr(e);
      return;
    }
  }
  if (!base.startsWith('https://')) {
    showErr(new Error('Upgrade link is not available. Try again or visit rootrecord.info.'));
    return;
  }
  const email = state.license && state.license.email ? String(state.license.email).trim() : '';
  let url = base;
  if (email) {
    const sep = base.includes('?') ? '&' : '?';
    url = `${base}${sep}prefilled_email=${encodeURIComponent(email)}`;
  }
  await rootRecord.openExternalUrl(url);
  window.addEventListener(
    'focus',
    async () => {
      try {
        const snap = await rootRecord.licensePrepare({ forceRefresh: true });
        if (snap && snap.proPaymentLinkBase) state.proPaymentLinkBase = String(snap.proPaymentLinkBase);
        if (snap && snap.authenticated) state.license = snap;
        syncGuestModeBanner();
        refreshProUpgradeButtonVisibility();
        applyReportsPlanLock();
        if (state.navKey === 'Account-Settings') loadAccount().catch(showErr);
      } catch (_) {
        /* ignore */
      }
    },
    { once: true }
  );
}

function refreshProUpgradeButtonVisibility() {
  const pro = hasProPlan();
  const accBtn = document.getElementById('btn-acct-upgrade-pro');
  const accHint = document.getElementById('acct-upgrade-hint');
  const repBtn = document.getElementById('btn-rep-upgrade-pro');
  if (accBtn) accBtn.hidden = pro;
  if (accHint) accHint.hidden = pro;
  if (repBtn) repBtn.hidden = pro;
}

async function onResetAllLocalData() {
  const inp = document.getElementById('acct-reset-confirm');
  const phrase = inp && inp.value.trim();
  const statusEl = document.getElementById('acct-reset-status');
  const btn = document.getElementById('btn-acct-reset');
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = 'Resetting…';
  try {
    await rootRecord.resetAllLocalData({ confirmPhrase: phrase });
    if (statusEl) statusEl.textContent = 'Data cleared. Reloading…';
    window.location.reload();
  } catch (e) {
    showErr(e);
    if (statusEl) statusEl.textContent = '';
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function onDeleteCloudSyncData() {
  const inp = document.getElementById('acct-cloud-reset-confirm');
  const phrase = inp && inp.value.trim();
  const statusEl = document.getElementById('acct-cloud-reset-status');
  const btn = document.getElementById('btn-acct-cloud-reset');
  const resetLocalBtn = document.getElementById('btn-acct-reset');
  const resetLocalInp = document.getElementById('acct-reset-confirm');
  if (btn) btn.disabled = true;
  if (resetLocalBtn) resetLocalBtn.disabled = true;
  if (resetLocalInp) resetLocalInp.disabled = true;
  if (statusEl) statusEl.textContent = 'Deleting cloud sync queue…';
  try {
    await rootRecord.deleteCloudSyncData({
      confirmPhrase: phrase,
      userId: state.userId != null && state.userId !== undefined ? state.userId : 1
    });
    if (inp) inp.value = '';
    if (!isGuestLocalLicense()) rootRecord.syncRun().catch(() => {});
    if (statusEl) {
      statusEl.textContent = isGuestLocalLicense()
        ? 'Cloud queue cleared. Sign in to enable Root Record cloud sync.'
        : 'Cloud queue cleared. Sync runs in the background.';
    }
    const syncSt = document.getElementById('acct-sync-status');
    if (syncSt) syncSt.textContent = '';
  } catch (e) {
    showErr(e);
    if (statusEl) statusEl.textContent = '';
  } finally {
    if (btn) btn.disabled = false;
    if (resetLocalBtn) resetLocalBtn.disabled = false;
    if (resetLocalInp) resetLocalInp.disabled = false;
  }
}

async function loadAbout() {
  const ver = document.getElementById('about-app-version');
  if (ver) ver.textContent = state.appVersion ? `Version ${state.appVersion}` : '';
}

async function loadFeedback() {
  const st = document.getElementById('feedback-status');
  if (st) st.textContent = '';
}

async function submitFeedbackForm() {
  const st = document.getElementById('feedback-status');
  const msgEl = document.getElementById('feedback-message');
  const message = msgEl && msgEl.value.trim();
  if (!message || message.length < 5) {
    if (st) st.textContent = 'Please enter your feedback (at least a few words).';
    return;
  }
  const btn = document.getElementById('btn-feedback-send');
  if (btn) btn.disabled = true;
  if (st) st.textContent = 'Sending…';
  try {
    const res = await rootRecord.submitFeedback({
      category: document.getElementById('feedback-category').value,
      message,
      contactEmail: document.getElementById('feedback-email').value.trim(),
      includeDiagnostics: document.getElementById('feedback-diag').checked
    });
    if (res.delivered) {
      if (st) st.textContent = 'Thank you — your feedback was sent.';
      if (msgEl) msgEl.value = '';
    } else if (res.ok && res.queued) {
      if (st) {
        st.textContent =
          (res.hint || 'Saved on this computer.') + ' Try sending again later; we keep your message until it can be delivered.';
      }
      if (msgEl) msgEl.value = '';
    } else if (!res.ok) {
      if (st) st.textContent = 'Could not send feedback.';
    }
  } catch (e) {
    showErr(e);
    if (st) st.textContent = '';
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadProgramSettings() {
  ensureTimezoneSelectsPopulated();
  const g = (id) => document.getElementById(id);
  const st = g('prog-save-status');
  if (st) st.textContent = '';
  const cur = await api('settingGet', pl({ key: 'currency_default', default: 'USD' }));
  if (g('prog-currency')) g('prog-currency').value = String(cur || 'USD');
  const th = await api('settingGet', pl({ key: 'theme', default: 'system' }));
  if (g('prog-theme')) g('prog-theme').value = String(th || 'system');
  const psec = await api('settingGet', pl({ key: 'prompt_interval_sec', default: 900 }));
  const pmin = Math.max(1, Math.round((Number(psec) || 900) / 60));
  if (g('prog-prompt-min')) g('prog-prompt-min').value = String(pmin);
  const pFirst = await api('settingGet', pl({ key: 'prompt_first_delay_sec', default: 120 }));
  if (g('prog-prompt-first-sec')) g('prog-prompt-first-sec').value = String(Math.max(30, Number(pFirst) || 120));
  const pTo = await api('settingGet', pl({ key: 'prompt_no_response_timeout_sec', default: 45 }));
  if (g('prog-prompt-timeout-sec')) g('prog-prompt-timeout-sec').value = String(Math.max(10, Number(pTo) || 45));
  const hz = await api('settingGet', pl({ key: 'default_hourly_cents', default: 0 }));
  if (g('prog-hourly')) g('prog-hourly').value = String(((Number(hz) || 0) / 100).toFixed(2));
  const tz = await api('settingGet', pl({ key: 'business_timezone', default: 'system' }));
  const tzNorm =
    tz === null || tz === undefined
      ? 'system'
      : (() => {
          const s = String(tz).trim();
          return s === '' || s.toLowerCase() === 'system' ? 'system' : s;
        })();
  if (g('prog-tz')) setTimezoneSelectValue(g('prog-tz'), tzNorm, false);
  await refreshAppDisplayTimeZone();
  const hb = await api('settingGet', pl({ key: 'help_bubbles_enabled', default: true }));
  if (g('prog-help')) g('prog-help').checked = Boolean(hb);
  const sm = await api('settingGet', pl({ key: 'show_money_in_dashboard', default: true }));
  if (g('prog-money-dash')) g('prog-money-dash').checked = Boolean(sm);
}

async function loadBusinessSettings() {
  ensureTimezoneSelectsPopulated();
  const g = (id) => document.getElementById(id);

  let mbRaw = false;
  try {
    mbRaw = await api('settingGet', pl({ key: 'multi_business_enabled', default: false }));
    if (g('bus-multi')) g('bus-multi').checked = parseSettingBool(mbRaw);
  } catch (_) {
    mbRaw = false;
    if (g('bus-multi')) g('bus-multi').checked = false;
  }

  applyBusinessPlanUi(hasProPlan(), mbRaw);

  const sel = g('bus-profile-select');
  if (!sel) return;

  let prof = [];
  try {
    prof = await api('listBusinessProfiles', pl({ includeArchived: true }));
  } catch (e) {
    console.error(e);
    showErr(e);
    sel.innerHTML = '';
    return;
  }

  const real = prof.filter((p) => parseInt(String(p.id), 10) > 0);
  const prev = sel.value;
  sel.innerHTML = '';
  for (const p of real) {
    const o = document.createElement('option');
    o.value = String(p.id);
    o.textContent = String(p.name || '') + (p.archived ? ' (archived)' : '');
    sel.appendChild(o);
  }

  let pick =
    pendingBusSelectId != null ? String(pendingBusSelectId) : null;
  pendingBusSelectId = null;

  if (!pick || ![...sel.options].some((o) => o.value === pick)) {
    if (prev && [...sel.options].some((o) => o.value === prev)) pick = prev;
    else if (
      state.activeBusinessId &&
      state.activeBusinessId !== 0 &&
      [...sel.options].some((o) => o.value === String(state.activeBusinessId))
    ) {
      pick = String(state.activeBusinessId);
    } else if (real.length) pick = String(real[0].id);
    else pick = '';
  }

  sel.value = pick || '';
  await fillBusinessFormFromSelection();
}

async function fillBusinessFormFromSelection() {
  const sel = document.getElementById('bus-profile-select');
  const row = await loadBusinessProfileRow(sel && sel.value ? parseInt(sel.value, 10) : NaN);
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = v !== undefined && v !== null ? String(v) : '';
  };
  const setChk = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.checked = Boolean(v && parseInt(String(v), 10) !== 0);
  };
  if (!row) {
    setVal('bus-name', '');
    setVal('bus-legal', '');
    setVal('bus-owner', '');
    setVal('bus-tax', '');
    setVal('bus-email', '');
    setVal('bus-phone', '');
    setVal('bus-site', '');
    setTimezoneSelectValue(document.getElementById('bus-timezone'), '', true);
    setVal('bus-address', '');
    setVal('bus-invoice-notes', '');
    setChk('bus-archived', false);
    return;
  }
  setVal('bus-name', row.name);
  setVal('bus-legal', row.legal_name);
  setVal('bus-owner', row.owner);
  setVal('bus-tax', row.tax_id);
  setVal('bus-email', row.email);
  setVal('bus-phone', row.phone);
  setVal('bus-site', row.website);
  setTimezoneSelectValue(document.getElementById('bus-timezone'), row.timezone, true);
  setVal('bus-address', row.address);
  setVal('bus-invoice-notes', row.invoice_notes);
  setChk('bus-archived', row.archived);
}

async function loadBusinessProfileRow(id) {
  if (!Number.isFinite(id) || id <= 0) return null;
  try {
    return await api('getBusinessProfile', pl({ id }));
  } catch (e) {
    console.error(e);
    showErr(e);
    return null;
  }
}

async function saveBusinessDetails() {
  const st = document.getElementById('bus-save-status');
  const sel = document.getElementById('bus-profile-select');
  const id = sel && sel.value ? parseInt(sel.value, 10) : NaN;
  const name = document.getElementById('bus-name') && document.getElementById('bus-name').value.trim();
  if (!Number.isFinite(id) || id <= 0) {
    if (st) st.textContent = 'Select a business first.';
    return;
  }
  if (!name) {
    if (st) st.textContent = 'Business name is required.';
    return;
  }
  try {
    await api(
      'saveBusinessProfile',
      pl({
        id,
        name,
        legal_name: document.getElementById('bus-legal').value.trim() || null,
        owner: document.getElementById('bus-owner').value.trim() || null,
        tax_id: document.getElementById('bus-tax').value.trim() || null,
        email: document.getElementById('bus-email').value.trim() || null,
        phone: document.getElementById('bus-phone').value.trim() || null,
        website: document.getElementById('bus-site').value.trim() || null,
        timezone: (() => {
          const v = document.getElementById('bus-timezone') && document.getElementById('bus-timezone').value.trim();
          return v || null;
        })(),
        address: document.getElementById('bus-address').value.trim() || null,
        invoice_notes: document.getElementById('bus-invoice-notes').value.trim() || null,
        archived: document.getElementById('bus-archived').checked
      })
    );
    if (st) st.textContent = 'Business details saved.';
    await loadBusinessSettings();
  } catch (e) {
    if (st) st.textContent = '';
    showErr(e);
  }
}

async function saveBusinessMultiPreference() {
  const st = document.getElementById('bus-save-status');
  try {
    const enableMulti = document.getElementById('bus-multi').checked;
    if (enableMulti && !hasProPlan()) {
      if (st) st.textContent = 'Multiple businesses require Pro.';
      const multi = document.getElementById('bus-multi');
      if (multi) multi.checked = false;
      return;
    }
    await api('settingSet', pl({ key: 'multi_business_enabled', value: enableMulti }));
    if (!enableMulti) {
      await api('settingSet', pl({ key: 'active_business_id', value: 1 }));
    }
    if (st) st.textContent = 'Multi-business preference saved.';
    await refreshProfiles();
  } catch (e) {
    if (st) st.textContent = '';
    showErr(e);
  }
}

async function onAddBusiness() {
  const st = document.getElementById('bus-save-status');
  if (!hasProPlan()) {
    if (st) st.textContent = 'Adding another business requires Pro.';
    return;
  }
  const raw = document.getElementById('bus-new-name');
  const name = raw && raw.value.trim();
  if (!name) {
    if (st) st.textContent = 'Enter a name for the new business.';
    return;
  }
  try {
    const res = await api('createBusinessProfile', pl({ name }));
    if (raw) raw.value = '';
    pendingBusSelectId = res && res.id != null ? res.id : null;
    if (st) st.textContent = 'Business added.';
    await loadBusinessSettings();
    await refreshProfiles();
  } catch (e) {
    if (st) st.textContent = '';
    showErr(e);
  }
}

async function saveProgramSettings() {
  const st = document.getElementById('prog-save-status');
  try {
    const currency = document.getElementById('prog-currency').value;
    const theme = document.getElementById('prog-theme').value;
    const pMin = parseInt(document.getElementById('prog-prompt-min').value, 10);
    const hourly = parseFloat(document.getElementById('prog-hourly').value);
    const tzRaw = document.getElementById('prog-tz').value.trim();
    await api('settingSet', pl({ key: 'currency_default', value: currency }));
    await api('settingSet', pl({ key: 'theme', value: theme }));
    await api('settingSet', pl({ key: 'prompt_interval_sec', value: Math.max(60, (Number.isFinite(pMin) ? pMin : 15) * 60) }));
    const firstSec = parseInt(document.getElementById('prog-prompt-first-sec').value, 10);
    await api('settingSet', pl({
      key: 'prompt_first_delay_sec',
      value: Math.max(30, Number.isFinite(firstSec) ? firstSec : 120)
    }));
    const tout = parseInt(document.getElementById('prog-prompt-timeout-sec').value, 10);
    await api('settingSet', pl({
      key: 'prompt_no_response_timeout_sec',
      value: Math.max(10, Number.isFinite(tout) ? tout : 45)
    }));
    await api('settingSet', pl({
      key: 'default_hourly_cents',
      value: Number.isFinite(hourly) ? Math.round(hourly * 100) : 0
    }));
    await api('settingSet', pl({ key: 'business_timezone', value: tzRaw === '' ? 'system' : tzRaw }));
    await api('settingSet', pl({ key: 'help_bubbles_enabled', value: document.getElementById('prog-help').checked }));
    await api('settingSet', pl({ key: 'show_money_in_dashboard', value: document.getElementById('prog-money-dash').checked }));
    applyThemeSetting(theme);
    await refreshAppDisplayTimeZone();
    try {
      await initCalendarDefaultsFromReportingZone();
    } catch (_) {
      /* ignore */
    }
    if (state.navKey === 'Dashboard') loadDashboard().catch(showErr);
    if (st) st.textContent = 'Settings saved.';
    try {
      const wst = await api('trackingStateGet', pl({}));
      if (activityPromptsArmed && wst.current_mode === 'working') {
        firstPromptAfterClockIn = false;
        await scheduleActivityPromptChain();
      }
    } catch (_) {
      /* ignore */
    }
  } catch (e) {
    if (st) st.textContent = '';
    showErr(e);
  }
}

async function refreshProfiles() {
  const sel = document.getElementById('profile-select');
  const row = document.getElementById('profile-row');
  if (!sel) return;

  let multi = false;
  try {
    const mbRaw = await api('settingGet', pl({ key: 'multi_business_enabled', default: false }));
    multi = parseSettingBool(mbRaw);
  } catch (_) {
    multi = false;
  }

  if (row) {
    row.hidden = !multi;
  }

  if (!multi) {
    try {
      const curRaw = await api('settingGet', pl({ key: 'active_business_id', default: 1 }));
      const curN = parseInt(String(curRaw), 10);
      if (Number.isNaN(curN) || curN <= 0) {
        await api('settingSet', pl({ key: 'active_business_id', value: 1 }));
      }
    } catch (_) {
      /* ignore */
    }
    state.activeBusinessId = 1;
    sel.innerHTML = '';
    return;
  }

  try {
    const prof = await api('listBusinessProfiles', pl({ includeArchived: true }));
    sel.innerHTML = '';
    for (const p of prof) {
      const o = document.createElement('option');
      o.value = String(p.id);
      o.textContent = p.name + (p.archived ? ' (archived)' : '');
      sel.appendChild(o);
    }
    const cur = await api('settingGet', pl({ key: 'active_business_id', default: 1 }));
    const want = String(cur);
    if ([...sel.options].some((o) => o.value === want)) {
      sel.value = want;
    } else {
      sel.value = '1';
    }
    const parsed = parseInt(sel.value, 10);
    state.activeBusinessId = Number.isNaN(parsed) ? 1 : parsed;
  } catch (e) {
    console.error(e);
    sel.innerHTML = '';
    const o = document.createElement('option');
    o.value = '1';
    o.textContent = 'Default (could not load profiles)';
    sel.appendChild(o);
    sel.value = '1';
    state.activeBusinessId = 1;
    showErr(e);
  }
}

async function onAddIncome() {
  const amt = parseFloat(document.getElementById('inc-amt').value);
  const desc = document.getElementById('inc-desc').value.trim();
  const cur = document.getElementById('inc-cur').value;
  if (!desc || Number.isNaN(amt)) return;
  const cents = Math.round(amt * 100);
  await api('insertIncome', pl({ received_at_utc: utcNowNaive(), amount_cents: cents, currency: cur, description: desc }));
  document.getElementById('inc-amt').value = '';
  document.getElementById('inc-desc').value = '';
  loadFinanceMoney();
  if (state.navKey === 'Dashboard') loadDashboard();
}

async function onAddExpense() {
  const amt = parseFloat(document.getElementById('exp-amt').value);
  const desc = document.getElementById('exp-desc').value.trim();
  const cur = document.getElementById('exp-cur').value;
  const fund = document.getElementById('exp-fund').value;
  if (!desc || Number.isNaN(amt)) return;
  const cents = Math.round(amt * 100);
  await api('insertExpense', pl({ spent_at_utc: utcNowNaive(), amount_cents: cents, currency: cur, description: desc, funding_source: fund }));
  document.getElementById('exp-amt').value = '';
  document.getElementById('exp-desc').value = '';
  loadFinanceMoney();
  if (state.navKey === 'Dashboard') loadDashboard();
}

async function onProfileChange() {
  const sel = document.getElementById('profile-select');
  if (!sel) return;
  const id = parseInt(sel.value, 10);
  if (Number.isNaN(id)) return;
  state.activeBusinessId = id;
  try {
    await api('settingSet', pl({ key: 'active_business_id', value: id }));
  } catch (e) {
    showErr(e);
    return;
  }
  if (state.navKey === 'Dashboard') loadDashboard().catch(showErr);
}

async function onOpenDbFolder() {
  const dir = state.dbPath.replace(/[/\\][^/\\]+$/, '');
  await rootRecord.openPath(dir);
}

/** Avoid throwing if an id is missing — one bad bind must not skip the rest of wireUi (nav + profile). */
function wireClick(id, listener) {
  const node = document.getElementById(id);
  if (!node) {
    console.warn('[RootRecord] wireUi: missing element #' + id);
    return;
  }
  node.addEventListener('click', listener);
}

function wireChange(id, listener) {
  const node = document.getElementById(id);
  if (!node) {
    console.warn('[RootRecord] wireUi: missing element #' + id);
    return;
  }
  node.addEventListener('change', listener);
}

function wireSidebarNavButtons() {
  document.querySelectorAll('#sidebar button.nav-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const panelKey = btn.getAttribute('data-panel');
      if (!panelKey) {
        console.warn('[RootRecord] Nav button has no data-panel:', btn);
        return;
      }
      const title = (btn.textContent && btn.textContent.trim()) || panelKey;
      setNavPanel(panelKey, title);
    });
  });
}

function wireUi() {
  if (uiWired) return;
  uiWired = true;
  ensureTimezoneSelectsPopulated();
  wireSidebarNavButtons();
  wireChange('profile-select', () => onProfileChange().catch(showErr));

  document.querySelectorAll('#panel-Finance-Clients .subnav button').forEach((b) => {
    b.addEventListener('click', () => switchFinance(b.dataset.sec));
  });
  wireClick('btn-add-income', () => onAddIncome().catch(showErr));
  wireClick('btn-add-expense', () => onAddExpense().catch(showErr));
  wireClick('btn-open-db', () => onOpenDbFolder());
  wireClick('btn-acct-reset', () => onResetAllLocalData().catch(showErr));
  wireClick('btn-acct-cloud-reset', () => onDeleteCloudSyncData().catch(showErr));
  wireChange('man-proj', () => toggleTrackingNewProjectField());

  document.getElementById('dash-scale')?.addEventListener('change', () => {
    state.dashSegmentIndex = defaultDashSegmentIndex();
    loadDashboard().catch(showErr);
  });
  document.getElementById('dash-custom-day')?.addEventListener('change', () => {
    state.dashSegmentIndex = 0;
    loadDashboard().catch(showErr);
  });
  ['dash-bd-mode'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => loadDashboard().catch(showErr));
  });

  wireClick('btn-refresh-tracking', () => loadTimeTracking().catch(showErr));
  wireClick('btn-update-task', () => promptUpdateCurrentTask().catch(showErr));
  wireClick('btn-clock-in', async () => {
    clearActivityPromptSchedule();
    firstPromptAfterClockIn = true;
    const { timeoutSec } = await readPromptConfig();
    const r = await openActivityDialog({
      title: 'Clock in',
      subtitle: 'What are you working on? This starts your paid task timer.',
      initialValue: '',
      timeoutSec,
      timeoutResolveText: () => 'Working'
    });
    if (r.cancelled) return;
    const desc = r.timedOut ? r.resolvedText || 'Working' : String(r.value || '').trim() || 'Working';
    const wc = document.getElementById('man-cat').value;
    let pjId = null;
    try {
      pjId = await resolveTrackingProjectId();
    } catch (e) {
      showErr(e);
      return;
    }
    await api('clockIn', pl({
      description: desc,
      work_category_id: wc ? parseInt(wc, 10) : null,
      project_id: pjId
    }));
    activityPromptsArmed = true;
    await loadTimeTracking();
    await scheduleActivityPromptChain();
  });
  wireClick('btn-clock-out', async () => {
    clearActivityPromptSchedule();
    activityPromptsArmed = false;
    firstPromptAfterClockIn = true;
    await api('clockOut', pl({}));
    await loadTimeTracking();
  });
  wireClick('btn-break-in', async () => {
    clearActivityPromptSchedule();
    const { timeoutSec } = await readPromptConfig();
    const r = await openActivityDialog({
      title: 'Start a break',
      subtitle: 'Optional note for this break.',
      initialValue: 'Break',
      timeoutSec,
      timeoutResolveText: () => 'Break'
    });
    if (r.cancelled) return;
    const desc = r.timedOut ? r.resolvedText || 'Break' : String(r.value || '').trim() || 'Break';
    await api('breakIn', pl({ description: desc }));
    await loadTimeTracking();
  });
  wireClick('btn-break-out', async () => {
    let stSnap = null;
    try {
      stSnap = await api('trackingStateGet', pl({}));
    } catch (_) {
      /* ignore */
    }
    const { timeoutSec } = await readPromptConfig();
    const hint = stSnap && stSnap.last_task_description ? String(stSnap.last_task_description) : 'Working';
    const r = await openActivityDialog({
      title: 'Resume work',
      subtitle: 'What are you returning to?',
      initialValue: hint,
      timeoutSec,
      timeoutResolveText: () => String(hint || 'Working')
    });
    if (r.cancelled) return;
    const resume = r.timedOut ? r.resolvedText || hint : String(r.value || '').trim() || hint;
    const wc = document.getElementById('man-cat').value;
    await api('breakOut', pl({
      work_category_id: wc ? parseInt(wc, 10) : null,
      project_id: null,
      resume_description: resume
    }));
    await loadTimeTracking();
    activityPromptsArmed = true;
    firstPromptAfterClockIn = true;
    await scheduleActivityPromptChain();
  });

  wireClick('btn-manual-entry', async () => {
    const s = document.getElementById('man-start').value;
    const e = document.getElementById('man-end').value;
    if (!s || !e) return;
    const startIso = new Date(s).toISOString();
    const endIso = new Date(e).toISOString();
    const wc = parseInt(document.getElementById('man-cat').value, 10);
    let pjId = null;
    try {
      pjId = await resolveTrackingProjectId();
    } catch (e) {
      showErr(e);
      return;
    }
    await api('insertManualTimeEntry', pl({
      start_iso: startIso,
      end_iso: endIso,
      work_category_id: wc,
      project_id: pjId,
      description: document.getElementById('man-desc').value || ''
    }));
    await loadTimeTracking();
    if (state.navKey === 'Dashboard') await loadDashboard();
  });

  wireClick('btn-save-cat', async () => {
    const name = document.getElementById('cat-name').value.trim();
    if (!name) return;
    const editId = document.getElementById('cat-edit-id').value.trim();
    if (editId) {
      await api('updateWorkCategoryById', pl({
        category_id: parseInt(editId, 10),
        name,
        color: document.getElementById('cat-color').value || '#2B8A8F',
        billable: parseInt(document.getElementById('cat-bill').value, 10)
      }));
    } else {
      await api('upsertWorkCategory', pl({
        name,
        color: document.getElementById('cat-color').value || '#2B8A8F',
        billable: parseInt(document.getElementById('cat-bill').value, 10)
      }));
    }
    document.getElementById('cat-edit-id').value = '';
    document.getElementById('cat-name').value = '';
    const b = document.getElementById('btn-save-cat');
    if (b) b.textContent = 'Save category';
    await loadTimeTracking();
  });
  wireClick('btn-clear-cat', () => {
    document.getElementById('cat-edit-id').value = '';
    document.getElementById('cat-name').value = '';
    const b = document.getElementById('btn-save-cat');
    if (b) b.textContent = 'Save category';
  });

  wireClick('btn-save-proj', async () => {
    const name = document.getElementById('proj-name').value.trim();
    if (!name) return;
    const editId = document.getElementById('proj-edit-id').value.trim();
    const payload = {
      name,
      client_name: document.getElementById('proj-client').value || null,
      currency: document.getElementById('proj-cur').value
    };
    if (editId) {
      payload.project_id = parseInt(editId, 10);
      await api('updateProject', pl(payload));
    } else {
      await api('insertProject', pl(payload));
    }
    document.getElementById('proj-edit-id').value = '';
    document.getElementById('proj-name').value = '';
    const b = document.getElementById('btn-save-proj');
    if (b) b.textContent = 'Save project';
    await loadTimeTracking();
  });
  wireClick('btn-clear-proj', () => {
    document.getElementById('proj-edit-id').value = '';
    document.getElementById('proj-name').value = '';
    document.getElementById('proj-client').value = '';
    document.getElementById('proj-cur').value = 'USD';
    const b = document.getElementById('btn-save-proj');
    if (b) b.textContent = 'Save project';
  });

  wireClick('btn-save-qa', async () => {
    const lid = document.getElementById('qa-label').value.trim();
    const wcRaw = document.getElementById('qa-cat').value;
    if (!lid || !wcRaw) return;
    const payload = {
      label: lid,
      work_category_id: parseInt(wcRaw, 10),
      project_id: document.getElementById('qa-proj').value ? parseInt(document.getElementById('qa-proj').value, 10) : null,
      default_description: document.getElementById('qa-desc').value || ''
    };
    const qe = document.getElementById('qa-edit-id').value.trim();
    if (qe) payload.id = parseInt(qe, 10);
    await api('saveQuickAction', pl(payload));
    document.getElementById('qa-edit-id').value = '';
    document.getElementById('qa-label').value = '';
    document.getElementById('qa-desc').value = '';
    const b = document.getElementById('btn-save-qa');
    if (b) b.textContent = 'Save quick action';
    await loadTimeTracking();
  });
  wireClick('btn-clear-qa', () => {
    document.getElementById('qa-edit-id').value = '';
    document.getElementById('qa-label').value = '';
    document.getElementById('qa-desc').value = '';
    const b = document.getElementById('btn-save-qa');
    if (b) b.textContent = 'Save quick action';
  });

  wireClick('btn-save-client', async () => {
    const name = document.getElementById('cl-name').value.trim();
    if (!name) return;
    const editId = document.getElementById('cl-edit-id').value.trim();
    const payload = {
      display_name: name,
      company: document.getElementById('cl-co').value,
      email: document.getElementById('cl-email').value,
      phone: document.getElementById('cl-phone').value,
      address: document.getElementById('cl-address').value.trim() || null,
      website: document.getElementById('cl-web').value.trim() || null,
      tax_id: document.getElementById('cl-tax').value.trim() || null,
      notes: document.getElementById('cl-notes').value.trim() || null
    };
    if (editId) payload.client_id = parseInt(editId, 10);
    await api('saveClient', pl(payload));
    clearClientForm();
    await loadFinanceClients();
  });
  wireClick('btn-clear-client', () => clearClientForm());

  wireClick('btn-debt-save', async () => {
    const amt = parseFloat(document.getElementById('debt-amt').value);
    if (Number.isNaN(amt)) return;
    const cents = Math.round(amt * 100);
    const created = datetimeLocalToUtcNaive(document.getElementById('debt-created').value) || utcNowNaive();
    const dueEl = document.getElementById('debt-due').value;
    const due = dueEl ? datetimeLocalToUtcNaive(dueEl) : null;
    const editId = document.getElementById('debt-edit-id').value.trim();
    if (editId) {
      await api('updateDebtEntry', pl({
        debt_id: parseInt(editId, 10),
        created_at_utc: created,
        due_at_utc: due,
        amount_cents: cents,
        currency: document.getElementById('debt-cur').value,
        creditor: document.getElementById('debt-cred').value,
        description: document.getElementById('debt-desc').value,
        status: document.getElementById('debt-meta-status').value || 'open',
        debt_type: document.getElementById('debt-meta-type').value || 'loan',
        account_ref: document.getElementById('debt-meta-ref').value || ''
      }));
    } else {
      await api('insertDebt', pl({
        created_at_utc: created,
        due_at_utc: due,
        amount_cents: cents,
        currency: document.getElementById('debt-cur').value,
        creditor: document.getElementById('debt-cred').value,
        description: document.getElementById('debt-desc').value
      }));
    }
    clearDebtForm();
    await loadFinanceDebts();
  });

  wireClick('btn-fund-save', async () => {
    const editId = document.getElementById('fund-edit-id').value.trim();
    const payload = {
      account_name: document.getElementById('fund-name').value,
      account_type: document.getElementById('fund-type').value,
      currency: document.getElementById('fund-cur').value,
      current_balance_cents: parseInt(document.getElementById('fund-bal').value, 10) || 0,
      credit_limit_cents: parseInt(document.getElementById('fund-lim').value, 10) || 0,
      notes: document.getElementById('fund-notes').value
    };
    if (editId) payload.account_id = parseInt(editId, 10);
    await api('upsertAvailableFundsAccount', pl(payload));
    clearFundForm();
    await loadFinanceFunds();
  });
  wireClick('btn-fund-clear', () => clearFundForm());

  wireClick('btn-schx-save', async () => {
    const amt = parseFloat(document.getElementById('schx-amt').value);
    if (Number.isNaN(amt)) return;
    const cents = Math.round(amt * 100);
    const nextDue = document.getElementById('schx-due').value.trim() || utcNowNaive();
    const editId = document.getElementById('schx-edit-id').value.trim();
    if (editId) {
      const proj = document.getElementById('schx-meta-proj').value.trim();
      const wc = document.getElementById('schx-meta-wc').value.trim();
      await api('updateScheduledExpense', pl({
        scheduled_id: parseInt(editId, 10),
        description: document.getElementById('schx-desc').value,
        amount_cents: cents,
        currency: document.getElementById('schx-cur').value,
        frequency: document.getElementById('schx-freq').value,
        next_due_utc: nextDue,
        project_id: proj ? parseInt(proj, 10) : null,
        work_category_id: wc ? parseInt(wc, 10) : null,
        billable: parseInt(document.getElementById('schx-meta-billable').value, 10) || 1,
        notes: document.getElementById('schx-meta-notes').value || null,
        active: 1
      }));
    } else {
      await api('addScheduledExpense', pl({
        description: document.getElementById('schx-desc').value,
        amount_cents: cents,
        currency: document.getElementById('schx-cur').value,
        frequency: document.getElementById('schx-freq').value,
        next_due_utc: nextDue
      }));
    }
    clearSchxForm();
    await loadFinanceScheduled();
  });
  wireClick('btn-schx-clear', () => clearSchxForm());

  wireClick('btn-res-save', async () => {
    const amt = parseFloat(document.getElementById('res-amt').value);
    if (Number.isNaN(amt)) return;
    const cents = Math.round(amt * 100);
    const when = datetimeLocalToUtcNaive(document.getElementById('res-at').value) || utcNowNaive();
    const editId = document.getElementById('res-edit-id').value.trim();
    if (editId) {
      await api('updateResourceEntry', pl({
        id: parseInt(editId, 10),
        at_utc: when,
        amount_cents: cents,
        currency: document.getElementById('res-cur').value,
        source_type: document.getElementById('res-src').value,
        description: document.getElementById('res-desc').value
      }));
    } else {
      await api('insertResourceEntry', pl({
        at_utc: when,
        amount_cents: cents,
        currency: document.getElementById('res-cur').value,
        source_type: document.getElementById('res-src').value,
        description: document.getElementById('res-desc').value
      }));
    }
    clearResForm();
    await loadFinanceResources();
  });
  wireClick('btn-res-clear', () => clearResForm());

  wireClick('btn-inv-create', async () => {
    const tax = parseInt(document.getElementById('inv-tax').value, 10) || 0;
    const cid = document.getElementById('inv-client-id').value;
    const res = await api('createInvoice', pl({
      client_id: cid ? parseInt(cid, 10) : null,
      issued_at_utc: utcNowNaive(),
      tax_cents: tax,
      currency: document.getElementById('inv-cur').value,
      status: 'draft'
    }));
    state.activeInvoiceId = res.id;
    await loadFinanceInvoices();
    await loadInvoiceDetail();
  });

  wireClick('btn-inv-load', () => loadInvoiceDetail().catch(showErr));

  wireClick('btn-inv-add-line', async () => {
    if (!state.activeInvoiceId) return;
    const lid = document.getElementById('inv-line-edit-id').value.trim();
    const payload = {
      invoice_id: state.activeInvoiceId,
      description: document.getElementById('inv-line-desc').value || 'Item',
      quantity: parseFloat(document.getElementById('inv-line-qty').value) || 1,
      unit_price_cents: parseInt(document.getElementById('inv-line-unit').value, 10) || 0
    };
    if (lid) payload.line_id = parseInt(lid, 10);
    await api('saveInvoiceLine', pl(payload));
    clearInvoiceLineForm();
    await loadInvoiceDetail();
    await loadFinanceInvoices();
  });
  wireClick('btn-inv-line-clear', () => clearInvoiceLineForm());

  wireClick('btn-ev-save', async () => {
    const tit = document.getElementById('ev-title').value.trim();
    if (!tit) return;
    const s = document.getElementById('ev-start').value;
    const e = document.getElementById('ev-end').value;
    if (!s) return;
    const payload = {
      title: tit,
      starts_at_utc: new Date(s).toISOString().replace(/\.\d{3}Z$/, '').replace('Z', ''),
      ends_at_utc: e ? new Date(e).toISOString().replace(/\.\d{3}Z$/, '').replace('Z', '') : null,
      status: document.getElementById('ev-status').value,
      client_id: document.getElementById('ev-client').value ? parseInt(document.getElementById('ev-client').value, 10) : null,
      project_id: document.getElementById('ev-proj').value ? parseInt(document.getElementById('ev-proj').value, 10) : null,
      notes: document.getElementById('ev-notes').value
    };
    const eid = document.getElementById('ev-edit-id').value.trim();
    if (eid) payload.event_id = parseInt(eid, 10);
    await api('saveScheduleEvent', pl(payload));
    clearScheduleForm();
    await loadSchedule();
  });
  wireClick('btn-ev-clear', () => clearScheduleForm());

  wireClick('btn-st-save', async () => {
    const sid = document.getElementById('st-edit-id').value.trim();
    const payload = {
      name: document.getElementById('st-name').value,
      sku: document.getElementById('st-sku').value.trim() || null,
      qty_on_hand: parseFloat(document.getElementById('st-qty').value) || 0,
      reorder_level: parseFloat(document.getElementById('st-reorder').value) || 0,
      unit: document.getElementById('st-unit').value || 'ea',
      unit_cost_cents: document.getElementById('st-cost').value ? parseInt(document.getElementById('st-cost').value, 10) : null,
      unit_price_cents: document.getElementById('st-price').value ? parseInt(document.getElementById('st-price').value, 10) : null,
      notes: document.getElementById('st-notes').value.trim() || null,
      currency: 'USD'
    };
    if (sid) payload.product_id = parseInt(sid, 10);
    await api('saveStockProduct', pl(payload));
    clearStockProductForm();
    await loadStock();
  });
  wireClick('btn-st-clear', () => clearStockProductForm());

  wireClick('btn-su-save', async () => {
    const sid = document.getElementById('su-edit-id').value.trim();
    const payload = {
      name: document.getElementById('su-name').value,
      qty_on_hand: parseFloat(document.getElementById('su-qty').value) || 0,
      reorder_level: parseFloat(document.getElementById('su-reorder').value) || 0,
      unit: document.getElementById('su-unit').value || 'ea',
      category: document.getElementById('su-cat').value || null,
      vendor: document.getElementById('su-vendor').value.trim() || null,
      notes: document.getElementById('su-notes').value.trim() || null
    };
    if (sid) payload.supply_id = parseInt(sid, 10);
    await api('saveSupply', pl(payload));
    clearSupplyForm();
    await loadStock();
  });
  wireClick('btn-su-clear', () => clearSupplyForm());

  wireClick('btn-rep-load', () => loadReports().catch(showErr));
  wireClick('btn-rep-generate', () => generateReportsSummaryPdf().catch(showErr));
  wireClick('btn-prog-save', () => saveProgramSettings().catch(showErr));

  wireClick('btn-wl-load', () => loadWorkLog().catch(showErr));
  wireClick('btn-wl-bulk-edit', () => openWorklogBulkDialog());
  wireClick('btn-wl-bulk-delete', () => bulkDeleteWorklog().catch(showErr));
  wireClick('btn-wl-edit-save', () => saveWorklogEdit());
  wireClick('btn-wl-edit-cancel', () => closeWorklogEditDialog());
  wireClick('btn-wl-bulk-apply', () => applyWorklogBulkEdit());
  wireClick('btn-wl-bulk-cancel', () => document.getElementById('dlg-worklog-bulk').close());
  wireClick('btn-wl-te-save', () => saveTimeEntryEdit().catch(showErr));
  wireClick('btn-wl-te-cancel', () => document.getElementById('dlg-time-entry-edit').close());
  wireClick('btn-wl-te-delete', () => deleteTimeEntryFromDialog().catch(showErr));
  wireClick('btn-fin-inc-save', () => saveIncomeEdit().catch(showErr));
  wireClick('btn-fin-inc-cancel', () => document.getElementById('dlg-fin-income').close());
  wireClick('btn-fin-inc-delete', () => deleteIncomeEdit().catch(showErr));
  wireClick('btn-fin-exp-save', () => saveExpenseEdit().catch(showErr));
  wireClick('btn-fin-exp-cancel', () => document.getElementById('dlg-fin-expense').close());
  wireClick('btn-fin-exp-delete', () => deleteExpenseEdit().catch(showErr));
  const wlSelAll = document.getElementById('wl-select-all');
  if (wlSelAll) {
    wlSelAll.addEventListener('change', (e) => {
      document.querySelectorAll('#worklog-table tbody .wl-row-check').forEach((cb) => {
        cb.checked = e.target.checked;
      });
      updateWorklogBulkButtons();
    });
  }
  const wlBulkDoType = document.getElementById('wl-bulk-do-type');
  const wlBulkDoDetail = document.getElementById('wl-bulk-do-detail');
  if (wlBulkDoType) {
    wlBulkDoType.addEventListener('change', (e) => {
      document.getElementById('wl-bulk-type').disabled = !e.target.checked;
    });
  }
  if (wlBulkDoDetail) {
    wlBulkDoDetail.addEventListener('change', (e) => {
      document.getElementById('wl-bulk-detail').disabled = !e.target.checked;
    });
  }

  wireChange('bus-profile-select', () => fillBusinessFormFromSelection().catch(showErr));
  wireClick('btn-bus-save', () => saveBusinessDetails().catch(showErr));
  wireClick('btn-bus-add', () => onAddBusiness().catch(showErr));
  wireClick('btn-bus-pref-save', () => saveBusinessMultiPreference().catch(showErr));

  wireClick('btn-feedback-send', () => submitFeedbackForm().catch(showErr));

  wireClick('btn-license-logout', () =>
    rootRecord
      .licenseLogout()
      .then(() => {
        window.location.reload();
      })
      .catch(showErr)
  );
  wireClick('btn-acct-upgrade-pro', () => openProUpgradeInBrowser().catch(showErr));
  wireClick('btn-rep-upgrade-pro', () => openProUpgradeInBrowser().catch(showErr));

  wireClick('btn-sync-now', () => onSyncNow().catch(showErr));
  wireClick('btn-sync-reupload', () => onSyncReuploadHistory().catch(showErr));

  const aboutPanel = document.getElementById('panel-About-Help');
  if (aboutPanel) {
    aboutPanel.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (!a || !aboutPanel.contains(a)) return;
      const href = a.getAttribute('href');
      if (!href) return;
      const lower = href.trim().toLowerCase();
      if (lower.startsWith('https://') || lower.startsWith('mailto:')) {
        e.preventDefault();
        rootRecord.openExternalUrl(href.trim()).catch(showErr);
      }
    });
  }
}

/** Best-effort text from IPC/rejected invoke (Electron may nest Error: prefixes). */
function unwrapGateError(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  const fromCause =
    err.cause && typeof err.cause === 'object' && typeof err.cause.message === 'string'
      ? err.cause.message.trim()
      : '';
  const top = typeof err.message === 'string' ? err.message.trim() : '';
  if (top && fromCause && !top.includes(fromCause)) return `${top} ${fromCause}`;
  return top || fromCause || String(err);
}

/** Strip repeated "Error invoking remote method …" / "Error:" wrappers from ipcRenderer.invoke failures. */
function stripInvokeNoise(s) {
  let t = String(s || '');
  for (let i = 0; i < 8; i += 1) {
    const next = t
      .replace(/^Error invoking remote method 'license-(?:login|signup)':\s*/i, '')
      .replace(/^Error:\s*/i, '')
      .trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

/** Avoid raw IPC noise in the gate; map known auth failures to copy; always surface a usable detail when safe. */
function humanizeLicenseGateError(err) {
  const raw = unwrapGateError(err);
  const stripped = stripInvokeNoise(raw);
  const blob = `${raw} ${stripped}`;
  const lower = blob.toLowerCase();

  if (blob.includes('LR_AUTH_INVALID_PASSWORD')) {
    return 'Password incorrect, please try again';
  }
  if (blob.includes('LR_AUTH_ACCOUNT_NOT_FOUND')) {
    return 'No account found! Please create an account or check your login information for errors.';
  }
  if (blob.includes('LR_AUTH_LEGACY_AMBIGUOUS')) {
    return 'Could not sign in. Check your email and password, or create an account if you are new.';
  }
  if (blob.includes('LR_AUTH_PASSWORD_NOT_SET') || blob.includes('PASSWORD_NOT_SET')) {
    return 'This account does not have a password yet. On the computer where you first used RootRecord, finish setup or use Create account / set password, then try signing in here with the same email.';
  }
  if (blob.includes('LR_AUTH_DEVICE_CONFLICT') || blob.includes('DEVICE_CONFLICT')) {
    return 'This device is already registered to a different RootRecord account. Sign in with the email that first used this PC, or contact support to move the device.';
  }
  if (blob.includes('LR_AUTH_INVALID_DEVICE_ID')) {
    return 'Could not verify this PC’s device ID. Quit RootRecord fully, wait a few seconds, and open it again. If this repeats, reinstall or remove the corrupted device file under Application Data.';
  }
  if (
    blob.includes('EMAIL_DEVICE_MISMATCH') ||
    /\bdifferent account\b/i.test(blob) ||
    /\balready registered to a different\b/i.test(blob)
  ) {
    return 'Sign-in reached the server, but this PC’s device registration conflicts with your account (often two accounts on one machine). Use the same email as on your other device, or contact support.';
  }

  // Offline / TLS / DNS / firewall (Electron undici often reports "fetch failed" or abort)
  if (
    lower.includes('aborterror') ||
    lower.includes('aborted') ||
    lower.includes('timeout') ||
    lower.includes('etimedout') ||
    lower.includes('fetch failed') ||
    lower.includes('failed to fetch') ||
    lower.includes('network error') ||
    lower.includes('network') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('enotfound') ||
    lower.includes('getaddrinfo') ||
    lower.includes('socket') ||
    lower.includes('cert') ||
    lower.includes('ssl') ||
    lower.includes('tls') ||
    lower.includes('enetunreach') ||
    lower.includes('eai_again')
  ) {
    return "Can't reach the sign-in service. Check your internet, VPN, firewall, and try again.";
  }

  if (stripped === 'Request failed.') {
    return "The sign-in service didn't return a usable response. Check your connection or try again shortly.";
  }

  // Prefer main/server message (truncate very long Worker bodies)
  if (stripped.length >= 3 && !stripped.includes('    at ')) {
    return stripped.length > 350 ? `${stripped.slice(0, 347)}…` : stripped;
  }

  return 'Could not complete sign-in. Please try again.';
}

let licenseGateWired = false;
function wireLicenseGate() {
  if (licenseGateWired) return;
  licenseGateWired = true;
  const btn = document.getElementById('btn-license-login');
  const btnSignup = document.getElementById('btn-license-signup');
  const btnGuest = document.getElementById('btn-license-guest-continue');
  const pwd = document.getElementById('license-password');
  const mail = document.getElementById('license-email');
  if (btn) btn.addEventListener('click', () => doLicenseLogin());
  if (btnSignup) btnSignup.addEventListener('click', () => doLicenseSignup());
  if (btnGuest) btnGuest.addEventListener('click', () => doLicenseGuestContinue());
  if (pwd) {
    pwd.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') doLicenseLogin();
    });
  }
  if (mail) {
    mail.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (pwd) pwd.focus();
      }
    });
  }
}

async function doLicenseLogin() {
  const errEl = document.getElementById('license-gate-err');
  const mailEl = document.getElementById('license-email');
  const pwdEl = document.getElementById('license-password');
  const btn = document.getElementById('btn-license-login');
  const btnSu = document.getElementById('btn-license-signup');
  const btnGuest = document.getElementById('btn-license-guest-continue');
  const email = mailEl && mailEl.value.trim();
  const password = pwdEl ? pwdEl.value : '';
  if (!email || !password) {
    if (errEl) errEl.textContent = 'Enter your email and password.';
    return;
  }
  if (errEl) errEl.textContent = '';
  if (btn) btn.disabled = true;
  if (btnSu) btnSu.disabled = true;
  if (btnGuest) btnGuest.disabled = true;
  try {
    const res = await rootRecord.licenseLogin({ email, password });
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('rr_bm_guest_local');
    state.license = res;
    const ok = await bootAfterLicense('');
    if (!ok) {
      if (errEl) errEl.textContent = BOOT_AFTER_LOGIN_FAILED_HINT;
      return;
    }
    const gate = document.getElementById('license-gate');
    const shell = document.getElementById('app-shell');
    if (gate) gate.hidden = true;
    if (shell) shell.hidden = false;
  } catch (e) {
    console.error('[license-login]', e);
    if (errEl) errEl.textContent = humanizeLicenseGateError(e);
  } finally {
    if (btn) btn.disabled = false;
    if (btnSu) btnSu.disabled = false;
    if (btnGuest) btnGuest.disabled = false;
  }
}

async function doLicenseSignup() {
  const errEl = document.getElementById('license-gate-err');
  const mailEl = document.getElementById('license-email');
  const pwdEl = document.getElementById('license-password');
  const btn = document.getElementById('btn-license-login');
  const btnSu = document.getElementById('btn-license-signup');
  const btnGuest = document.getElementById('btn-license-guest-continue');
  const email = mailEl && mailEl.value.trim();
  const password = pwdEl ? pwdEl.value : '';
  if (!email || !password) {
    if (errEl) errEl.textContent = 'Choose an email and password for your new account.';
    return;
  }
  if (errEl) errEl.textContent = '';
  if (btn) btn.disabled = true;
  if (btnSu) btnSu.disabled = true;
  if (btnGuest) btnGuest.disabled = true;
  try {
    const res = await rootRecord.licenseSignup({ email, password });
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('rr_bm_guest_local');
    state.license = res;
    const ok = await bootAfterLicense('');
    if (!ok) {
      if (errEl) errEl.textContent = BOOT_AFTER_LOGIN_FAILED_HINT;
      return;
    }
    const gate = document.getElementById('license-gate');
    const shell = document.getElementById('app-shell');
    if (gate) gate.hidden = true;
    if (shell) shell.hidden = false;
  } catch (e) {
    console.error('[license-signup]', e);
    if (errEl) errEl.textContent = humanizeLicenseGateError(e);
  } finally {
    if (btn) btn.disabled = false;
    if (btnSu) btnSu.disabled = false;
    if (btnGuest) btnGuest.disabled = false;
  }
}

/** Local-only this run: `sessionStorage` clears when the app fully quits, so the gate returns next launch. */
async function doLicenseGuestContinue() {
  const errEl = document.getElementById('license-gate-err');
  const btn = document.getElementById('btn-license-login');
  const btnSu = document.getElementById('btn-license-signup');
  const btnGuest = document.getElementById('btn-license-guest-continue');
  if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('rr_bm_guest_local', '1');
  if (errEl) errEl.textContent = '';
  if (btn) btn.disabled = true;
  if (btnSu) btnSu.disabled = true;
  if (btnGuest) btnGuest.disabled = true;
  try {
    await boot();
  } catch (e) {
    console.error('[license-guest-continue]', e);
    if (errEl) errEl.textContent = humanizeLicenseGateError(e);
  } finally {
    if (btn) btn.disabled = false;
    if (btnSu) btnSu.disabled = false;
    if (btnGuest) btnGuest.disabled = false;
  }
}

async function bootAfterLicense(toolbarHint) {
  let b;
  try {
    b = await rootRecord.bootstrap();
  } catch (e) {
    console.error('[bootstrap]', e);
    return false;
  }
  if (!b || !b.ok) {
    console.error('[bootstrap] Database did not open; see main process log.');
    return false;
  }

  try {
    wireUi();
  } catch (e) {
    console.error('wireUi', e);
  }
  state.dbPath = b.dbPath;
  state.userId = b.defaultUserId || 1;
  state.appVersion = b.appVersion != null && String(b.appVersion).trim() !== '' ? String(b.appVersion).trim() : '';
  const ts = document.getElementById('toolbar-sub');
  if (ts) ts.textContent = toolbarHint || '';
  try {
    const theme = await api('settingGet', pl({ key: 'theme', default: 'system' }));
    applyThemeSetting(theme);
  } catch (_) {
    applyThemeSetting('system');
  }
  try {
    await refreshAppDisplayTimeZone();
  } catch (_) {
    /* ignore */
  }
  try {
    await initCalendarDefaultsFromReportingZone();
  } catch (_) {
    initDashDateDefault();
    initReportDateDefaults();
    initWorkLogDateDefaults();
  }
  try {
    await refreshProfiles();
  } catch (e) {
    showErr(e);
  }
  activityPromptsArmed = false;
  clearActivityPromptSchedule();
  try {
    await enforceFreePlanConstraints();
  } catch (_) {
    /* ignore */
  }
  applyReportsPlanLock();
  let mbBoot = false;
  try {
    mbBoot = await api('settingGet', pl({ key: 'multi_business_enabled', default: false }));
  } catch (_) {
    mbBoot = false;
  }
  applyBusinessPlanUi(hasProPlan(), mbBoot);
  syncGuestModeBanner();
  if (!isGuestLocalLicense()) rootRecord.syncRun().catch(() => {});
  setNavPanel('Dashboard', 'Dashboard');
  return true;
}

async function boot() {
  wireLicenseGate();
  if (typeof rootRecord === 'undefined') {
    const ge = document.getElementById('license-gate-err');
    if (ge) {
      ge.textContent =
        'App security bridge failed to load (preload). Fully quit RootRecord and start again. If this persists, reinstall.';
    }
    console.error('[boot] window.rootRecord is missing — preload did not run or crashed before exposeInMainWorld.');
    return;
  }
  let prep;
  try {
    prep = await rootRecord.licensePrepare();
  } catch (e) {
    console.error('[license-prepare]', e);
    const ge = document.getElementById('license-gate-err');
    if (ge) ge.textContent = humanizeLicenseGateError(e);
    return;
  }
  const guestLocal =
    typeof sessionStorage !== 'undefined' && sessionStorage.getItem('rr_bm_guest_local') === '1';

  if (prep && prep.authenticated) {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('rr_bm_guest_local');
    state.license = prep;
  } else if (guestLocal) {
    try {
      await rootRecord.licenseLogout();
    } catch (_) {
      /* ignore */
    }
    let prepFresh = prep;
    try {
      prepFresh = await rootRecord.licensePrepare();
    } catch (_) {
      /* keep prior prep */
    }
    const base = prepFresh && typeof prepFresh === 'object' ? prepFresh : prep || {};
    state.license = {
      ...base,
      authenticated: false,
      guestLocal: true,
      proUnlocked: false,
      isPaidMember: false,
      membershipLabel: 'Not signed in (this session only)',
      planTier: 'free',
      planLabel: 'Free',
      email: '',
      access: '',
      reason: '',
      accountId: '',
      subscriptionStatus: ''
    };
  } else {
    const ge = document.getElementById('license-gate-err');
    if (ge) {
      const m =
        prep && typeof prep.message === 'string' && prep.message.trim()
          ? prep.message.trim()
          : '';
      ge.textContent = m || 'Please sign in to continue.';
    }
    return;
  }
  if (state.license && state.license.proPaymentLinkBase) {
    state.proPaymentLinkBase = String(state.license.proPaymentLinkBase);
  }
  const licHint = state.license || {};
  const hint = licHint.offlineGrace && licHint.warning ? String(licHint.warning || '').trim() : '';
  const ok = await bootAfterLicense(hint);
  if (!ok) {
    const ge = document.getElementById('license-gate-err');
    if (ge) ge.textContent = BOOT_DATA_FAILED_HINT;
    return;
  }
  const gate = document.getElementById('license-gate');
  const shell = document.getElementById('app-shell');
  if (gate) gate.hidden = true;
  if (shell) shell.hidden = false;
}

boot().catch((e) => {
  console.error(e);
  showErr(e);
});
