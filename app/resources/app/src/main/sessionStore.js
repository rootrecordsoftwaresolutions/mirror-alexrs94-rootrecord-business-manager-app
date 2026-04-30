'use strict';

const fs = require('fs');
const { dataDir, machineSessionPath, stateJsonPath, ensureUserLayout } = require('./paths');

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(require('path').dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function initMachineSession(startedAtUtcZ) {
  fs.mkdirSync(dataDir(), { recursive: true });
  writeJson(machineSessionPath(), {
    started_at_utc: startedAtUtcZ,
    db_machine_session_id: null
  });
}

function getMachineSessionStartedAt() {
  const d = readJsonSafe(machineSessionPath(), null);
  return d && d.started_at_utc ? String(d.started_at_utc) : null;
}

function getMachineSessionDbId() {
  const d = readJsonSafe(machineSessionPath(), null);
  if (!d || d.db_machine_session_id == null) return null;
  return parseInt(String(d.db_machine_session_id), 10);
}

function setMachineSessionDbId(id) {
  const p = machineSessionPath();
  const raw = readJsonSafe(p, {});
  raw.db_machine_session_id = id;
  if (!raw.started_at_utc) raw.started_at_utc = new Date().toISOString();
  writeJson(p, raw);
}

function loadUserState(userId) {
  const p = stateJsonPath(userId);
  const raw = readJsonSafe(p, null);
  if (!raw) return null;
  // Legacy "evaluation phase" is no longer used; strip flags so UI and IPC never show stale "in progress".
  const state = {
    evaluation_active: false,
    evaluation_start_utc: null,
    current_work_start_utc: raw.current_work_start_utc ?? null,
    current_work_description: raw.current_work_description ?? null,
    current_work_category_id: raw.current_work_category_id ?? null,
    current_project_id: raw.current_project_id ?? null,
    current_tag_ids: raw.current_tag_ids ?? null,
    current_mode: String(raw.current_mode || 'off'),
    last_task_description: raw.last_task_description ?? null,
    last_prompt_auto_fill_utc: raw.last_prompt_auto_fill_utc ?? null
  };
  if (raw.evaluation_active || raw.evaluation_start_utc != null) {
    saveUserState(userId, state);
  }
  return state;
}

function saveUserState(userId, state) {
  ensureUserLayout(userId);
  writeJson(stateJsonPath(userId), {
    evaluation_active: state.evaluation_active,
    evaluation_start_utc: state.evaluation_start_utc,
    current_work_start_utc: state.current_work_start_utc,
    current_work_description: state.current_work_description,
    current_work_category_id: state.current_work_category_id,
    current_project_id: state.current_project_id,
    current_tag_ids: state.current_tag_ids,
    current_mode: state.current_mode,
    last_task_description: state.last_task_description,
    last_prompt_auto_fill_utc: state.last_prompt_auto_fill_utc
  });
}

function resetUserForNewMachineSession(userId, machineStartIso) {
  const st = {
    evaluation_active: false,
    evaluation_start_utc: null,
    current_work_start_utc: null,
    current_work_description: null,
    current_work_category_id: null,
    current_project_id: null,
    current_tag_ids: null,
    current_mode: 'off',
    last_task_description: null,
    last_prompt_auto_fill_utc: null
  };
  saveUserState(userId, st);
  return st;
}

module.exports = {
  initMachineSession,
  getMachineSessionStartedAt,
  getMachineSessionDbId,
  setMachineSessionDbId,
  loadUserState,
  saveUserState,
  resetUserForNewMachineSession
};
