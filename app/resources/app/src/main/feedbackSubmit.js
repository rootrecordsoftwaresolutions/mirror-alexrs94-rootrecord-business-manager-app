'use strict';

/**
 * Sends feedback to your backend (e.g. HTTP API that writes MySQL on a dedicated device).
 *
 * Environment (optional until your server is ready):
 *   RR_FEEDBACK_API_URL   — full HTTPS URL for POST (JSON body)
 *   RR_FEEDBACK_API_KEY   — optional secret; sent as Authorization: Bearer <key>
 *
 * If the URL is unset or the request fails, the payload is appended to
 * pending-feedback.jsonl under the app userData directory for later retry or manual import.
 */

const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');

let cachedVersion;
function appVersion() {
  if (cachedVersion != null) return cachedVersion;
  try {
    cachedVersion = require(path.join(__dirname, '..', '..', 'package.json')).version;
  } catch (_) {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

function queuePath() {
  return path.join(app.getPath('userData'), 'pending-feedback.jsonl');
}

async function appendQueue(record) {
  const line = `${JSON.stringify(record)}\n`;
  await fs.appendFile(queuePath(), line, 'utf8');
}

function isProductionSafeFeedbackUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
  } catch {
    /* ignore */
  }
  return false;
}

async function postToRemote(body) {
  const url = String(process.env.RR_FEEDBACK_API_URL || '').trim();
  if (!url) return { skipped: true, reason: 'no_url' };
  if (!isProductionSafeFeedbackUrl(url)) {
    console.warn('[RootRecord] RR_FEEDBACK_API_URL must be https:// (except http localhost). Skipping remote POST.');
    return { skipped: true, reason: 'insecure_or_invalid_url' };
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
  const key = String(process.env.RR_FEEDBACK_API_KEY || '').trim();
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (res.ok) {
      return { skipped: false, ok: true, status: res.status };
    }
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 500);
    } catch (_) {
      /* ignore */
    }
    return { skipped: false, ok: false, status: res.status, detail };
  } catch (e) {
    clearTimeout(t);
    return {
      skipped: false,
      ok: false,
      status: 0,
      detail: e && e.name === 'AbortError' ? 'Request timed out' : String(e.message || e)
    };
  }
}

/**
 * @param {object} payload — from renderer: category, message, contactEmail?, includeDiagnostics?
 */
async function submitFeedback(payload = {}) {
  const message = String(payload.message || '').trim();
  if (message.length < 5) {
    throw new Error('Please enter a bit more detail (at least a few words).');
  }

  const category = String(payload.category || 'general').trim() || 'general';
  const contactEmail = String(payload.contactEmail || '').trim();
  const includeDiagnostics = Boolean(payload.includeDiagnostics);

  const base = {
    category,
    message,
    contactEmail: contactEmail || null,
    includeDiagnostics,
    submittedAtUtc: new Date().toISOString()
  };
  const body = includeDiagnostics
    ? {
        ...base,
        client: {
          app: 'RootRecord Business Manager',
          version: appVersion(),
          platform: process.platform,
          arch: process.arch
        }
      }
    : { ...base, client: null };

  const remote = await postToRemote(body);

  if (remote.skipped || !remote.ok) {
    const queued = {
      ...body,
      _queue: {
        at: body.submittedAtUtc,
        reason: remote.skipped ? 'api_url_not_configured' : 'remote_failed',
        remoteStatus: remote.status || null,
        remoteDetail: remote.detail || null
      }
    };
    await appendQueue(queued);
    return {
      ok: true,
      delivered: false,
      queued: true,
      queuePath: queuePath(),
      hint: remote.skipped
        ? 'No feedback server URL is configured yet. Your message was saved on this computer.'
        : 'The feedback server could not be reached. Your message was saved on this computer for later retry or import.'
    };
  }

  return {
    ok: true,
    delivered: true,
    queued: false
  };
}

module.exports = { submitFeedback, queuePath };
