/* GroupPing background worker (v0.5).
   - Every hour (setting: 1h or 3h): opens/reads chats in the WhatsApp Web tab
     (only chats with new activity), sends ONLY never-before-scanned messages to
     Gemini in one batched call, stores plans/events/decisions/deadlines/requests.
   - Every evening: a final scan, then ONE Gemini call for a complete summary of
     the day across all groups.
   - Hourly: re-checks the chat list for chats waiting on your reply.
   - Answers the popup/options pages (dashboard data, resolve, snooze, mute...).
   Alarms only fire while Chrome is running; WhatsApp Web must be open in a tab. */
'use strict';

importScripts('shared.js');

const ALARM_SCAN = 'gp-scan';
const ALARM_EVENING = 'gp-evening';
const ALARM_UNREPLIED = 'gp-unreplied';
const ALARM_KICKOFF = 'gp-kickoff';
const REMIND_PREFIX = 'gp-remind-';
const SNOOZE_PREFIX = 'gp-snooze-';

function log(msg) { gpLog('background', msg); }

/* ---------------- storage helpers ---------------- */

function getAll(keys) { return new Promise((resolve) => chrome.storage.local.get(keys, resolve)); }
function setAll(obj) { return new Promise((resolve) => chrome.storage.local.set(obj, resolve)); }

/* One writer at a time for the big stores, so the content script, scans and
   popup actions never overwrite each other. */
let storeLock = Promise.resolve();
function withLock(fn) {
  const p = storeLock.then(fn, fn);
  storeLock = p.catch(() => {});
  return p;
}

const SETTINGS_DEFAULTS = {
  geminiKey: '', model: GP.DEFAULT_MODEL,
  summaryTime: GP.DEFAULT_SUMMARY_TIME, licenseKey: '', notifications: true,
  unrepliedDays: GP.DEFAULT_UNREPLIED_DAYS,
  unrepliedNudgeHours: GP.DEFAULT_NUDGE_HOURS,
  unrepliedAlerts: true,
  importantNames: '', unrepliedMuteNames: '',
  scanMinutes: GP.SCAN_MINUTES,   // 60 or 180
  windowDays: GP.DEFAULT_WINDOW_DAYS, // never look at chats/messages older than this
  deepRead: true,                 // open chats with new activity to read them
  localOnly: false,               // PRIVACY: no Gemini calls at all; chat-list reminders only
  remindMinutes: 60,              // reminder before an event
  upgradeUrl: '',                 // checkout link placeholder (set later)
  eveningSummary: true, eventAlerts: true
};

async function getSettings() {
  const d = await getAll([GP.STORE.SETTINGS, GP.STORE.INSTALL]);
  return {
    settings: Object.assign({}, SETTINGS_DEFAULTS, d[GP.STORE.SETTINGS] || {}),
    installTs: d[GP.STORE.INSTALL] || Date.now()
  };
}

/* ---------------- alarms ---------------- */

function nextEveningTs(timeStr) {
  const parts = (timeStr || GP.DEFAULT_SUMMARY_TIME).split(':');
  const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10) || 0;
  const t = new Date();
  t.setHours(isNaN(h) ? 20 : h, m, 0, 0);
  if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

/* v0.5.8 one-time cleanup: v0.5.7 could store the SAME messages under several
   group names (the pane never changed but the scan believed it had). Message
   ids are unique per group, so any id found under two names proves a bad
   attribution. Every group involved loses its stored messages, summary and
   items and is re-read from scratch on the next scan - the popup never shows a
   summary built from another group's messages. */
async function purgeDuplicateGroups() {
  const V = '0.5.8';
  const d = await getAll([GP.STORE.MSGS, GP.STORE.EVENTS, GP.STORE.DIGESTS, GP.STORE.CURSOR, GP.STORE.CHATLIST, GP.STORE.SUMMARIES, GP.STORE.DUPPURGED]);
  if (d[GP.STORE.DUPPURGED] === V) return;
  const store = d[GP.STORE.MSGS] || {};
  const owner = new Map(), bad = new Set();
  Object.keys(store).forEach((g) => {
    const ids = (store[g].messages || []).map(m => m.id).concat(Object.keys(store[g].seen || {}));
    ids.forEach((id) => {
      const o = owner.get(id);
      if (o === undefined) owner.set(id, g);
      else if (o !== g) { bad.add(o); bad.add(g); }
    });
  });
  if (bad.size) {
    const digests = d[GP.STORE.DIGESTS] || {}, cursor = d[GP.STORE.CURSOR] || {}, chatlist = d[GP.STORE.CHATLIST] || {}, sums = d[GP.STORE.SUMMARIES] || {};
    bad.forEach((g) => {
      delete store[g]; delete digests[g]; delete cursor[g];
      if (chatlist[g]) { chatlist[g].readSig = ''; }
      Object.keys(sums).forEach((day) => { if (sums[day] && sums[day].groups) { delete sums[day].groups[g]; if (sums[day].counts) delete sums[day].counts[g]; } });
    });
    const events = (d[GP.STORE.EVENTS] || []).filter(e => !bad.has(e.group));
    await setAll({ [GP.STORE.MSGS]: store, [GP.STORE.DIGESTS]: digests, [GP.STORE.CURSOR]: cursor, [GP.STORE.CHATLIST]: chatlist,
      [GP.STORE.SUMMARIES]: sums, [GP.STORE.EVENTS]: events });
    log('cleanup: found the same messages stored under several group names (a v0.5.7 mistake) - cleared stored data, summaries and items for: ' +
        Array.from(bad).join(', ') + '. They are re-read on the next scan.');
  }
  await setAll({ [GP.STORE.DUPPURGED]: V });
}

/* One-time cleanup on update. v0.5.3 (privacy): remove every stored direct
   chat, strip previews of groups that are not selected, and re-run the
   redaction guard over everything an older version stored. */
async function purgeExcludedChats() {
  const V = '0.5.3';
  const d = await getAll([GP.STORE.MSGS, GP.STORE.EVENTS, GP.STORE.CHATLIST, GP.STORE.UNRLIST, GP.STORE.PURGED, GP.STORE.SELGROUPS]);
  if (d[GP.STORE.PURGED] === V) return;
  const selected = gpSelectedGroups(d[GP.STORE.SELGROUPS]);
  const msgs = d[GP.STORE.MSGS] || {};
  let redactedCount = 0, droppedCount = 0;
  Object.keys(msgs).forEach((g) => {
    if (gpIsExcludedChat(g)) { delete msgs[g]; return; }
    (msgs[g].messages || []).forEach((m) => { if (m.scanned === undefined) m.scanned = true; });
    // re-redact anything stored by an older, unguarded version
    msgs[g].messages = (msgs[g].messages || []).filter((m) => {
      const r = gpRedactText(m && m.text);
      if (r.dropped) { droppedCount++; return false; }
      if (r.redacted) { redactedCount++; m.text = r.text; }
      return true;
    });
    if (!msgs[g].messages.length) delete msgs[g];
  });
  const events = (d[GP.STORE.EVENTS] || []).filter(e => !gpIsExcludedChat(e.group));
  const chatlist = d[GP.STORE.CHATLIST] || {};
  Object.keys(chatlist).forEach((n) => {
    // hard rule: only positively-identified groups stay; direct chats vanish entirely
    if (gpIsExcludedChat(n) || chatlist[n].isGroup !== true) { delete chatlist[n]; return; }
    if (!selected.has(n)) chatlist[n].preview = ''; // previews are content: selected groups only
    else { const r = gpRedactText(chatlist[n].preview || ''); chatlist[n].preview = r.dropped ? '' : r.text; }
  });
  let unrl = d[GP.STORE.UNRLIST];
  if (unrl && Array.isArray(unrl.items)) unrl = { at: unrl.at, items: unrl.items.filter(i => !gpIsExcludedChat(i.name)) };
  await setAll({ [GP.STORE.MSGS]: msgs, [GP.STORE.EVENTS]: events, [GP.STORE.CHATLIST]: chatlist,
    [GP.STORE.UNRLIST]: unrl, [GP.STORE.PURGED]: V });
  if (redactedCount || droppedCount) log('privacy cleanup: masked ' + redactedCount + ' stored message(s), removed ' + droppedCount + ' sensitive message(s) saved by an older version');
}

async function setupAlarms() {
  await purgeExcludedChats().catch(() => {});
  await purgeDuplicateGroups().catch((e) => log('duplicate cleanup error: ' + e.message));
  const s0 = await getSettings();
  await purgeOldData(s0.settings).catch((e) => log('window purge error: ' + e.message));
  const { settings } = await getSettings();
  const every = settings.scanMinutes === 180 ? 180 : 60;
  chrome.alarms.create(ALARM_SCAN, { periodInMinutes: every, delayInMinutes: 5 });
  chrome.alarms.create(ALARM_EVENING, { when: nextEveningTs(settings.summaryTime), periodInMinutes: 1440 });
  chrome.alarms.create(ALARM_UNREPLIED, { periodInMinutes: GP.UNR_CHECK_MINUTES, delayInMinutes: 3 });
  // re-create upcoming event reminders (alarms can be lost on browser restart)
  const events = (await getAll([GP.STORE.EVENTS]))[GP.STORE.EVENTS] || [];
  events.forEach((e) => scheduleReminder(e, settings));
  log('alarms set: scan every ' + (every === 180 ? '3 hours' : 'hour') + ', evening scan + summary at ' + settings.summaryTime +
      ', reply-reminder check every ' + GP.UNR_CHECK_MINUTES + ' min');
}

function scheduleReminder(ev, settings) {
  if (!ev || ev.reminded || ev.state === 'resolved' || !ev.whenTs) return;
  const lead = Math.max(5, parseInt(ev.remindMinutes || (settings && settings.remindMinutes) || 60, 10)) * 60000;
  const at = ev.whenTs - lead;
  if (at > Date.now() + 5000) chrome.alarms.create(REMIND_PREFIX + ev.id, { when: at });
}

/* A first scan shortly after install/update/browser start, so the user never
   has to press anything. Runs only when a Gemini key exists; otherwise the
   popup's Connect Now flow starts the first scan. */
function scheduleKickoff(why) {
  chrome.alarms.create(ALARM_KICKOFF, { when: Date.now() + 30000 });
  log(why + ': first scan will start by itself in about 30 seconds');
}
async function kickoffScan() {
  const { settings } = await getSettings();
  if (!settings.geminiKey && !settings.localOnly) {
    log('auto-start: no Gemini key yet - scanning starts after you press Connect Now in the popup. ' +
        'Note: removing and re-adding the extension wipes saved settings, so after a reinstall the key must be pasted again.');
    return;
  }
  await fullScan('auto-start');
}

chrome.runtime.onInstalled.addListener((info) => {
  chrome.storage.local.get(GP.STORE.INSTALL, (d) => {
    if (!d[GP.STORE.INSTALL]) chrome.storage.local.set({ [GP.STORE.INSTALL]: Date.now() });
  });
  setupAlarms();
  if (info.reason === 'install') log('installed. Open the GroupPing popup to connect.');
  if (info.reason === 'update') log('updated to ' + chrome.runtime.getManifest().version + '. The WhatsApp tab will be reloaded automatically if needed.');
  scheduleKickoff(info.reason === 'update' ? 'updated' : 'installed');
});
chrome.runtime.onStartup.addListener(() => { setupAlarms(); scheduleKickoff('browser started'); });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_KICKOFF) kickoffScan().catch(e => log('auto-start error: ' + e.message));
  else if (alarm.name === ALARM_SCAN) fullScan('hourly').catch(e => log('scan error: ' + e.message));
  else if (alarm.name === ALARM_EVENING) eveningRun().catch(e => log('evening error: ' + e.message));
  else if (alarm.name === ALARM_UNREPLIED) runUnrepliedCheck('hourly check').catch(e => log('reply-reminder error: ' + e.message));
  else if (alarm.name.startsWith(REMIND_PREFIX)) fireReminder(alarm.name.slice(REMIND_PREFIX.length)).catch(() => {});
  else if (alarm.name.startsWith(SNOOZE_PREFIX)) fireSnooze(alarm.name.slice(SNOOZE_PREFIX.length)).catch(() => {});
});

/* ---------------- Gemini ---------------- */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* One attempt. Errors carry .status and .retryable so the wrapper can decide
   whether trying again (or another model) could help. */
async function callGeminiOnce(apiKey, model, prompt, json) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: json ? { temperature: 0.1, responseMimeType: 'application/json' } : { temperature: 0.1 }
      })
    });
  } catch (e) {
    const err = new Error('network error reaching Gemini: ' + e.message);
    err.retryable = true;
    throw err;
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (res.status === 404) {
      const err404 = new Error('Gemini HTTP 404: model unavailable. Change the model name in Options and try again.');
      err404.status = 404; err404.retryable = false;
      throw err404;
    }
    const err = new Error('Gemini HTTP ' + res.status + ': ' + body);
    err.status = res.status;
    // 503 = high demand, 429 = rate limit, 5xx = Google-side problem: all worth a retry.
    err.retryable = [429, 500, 502, 503, 504].indexOf(res.status) !== -1;
    throw err;
  }
  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  const text = cand && cand.content && cand.content.parts
    ? cand.content.parts.map(p => p.text || '').join('') : '';
  if (!text) throw new Error('Gemini returned an empty answer');
  return text;
}

/* Call Gemini with automatic retries and a fallback model:
   - the chosen model gets up to 3 attempts (waits 4s, then 12s) when Google
     reports high demand / rate limit / a 5xx;
   - if it still cannot answer, the fallback model (a different, high-throughput
     one) gets up to 2 attempts;
   - bad key / bad model name / empty answers fail immediately, no retry.
   Every retry and fallback is written to the Debug log. */
async function callGemini(apiKey, model, prompt, json) {
  const primary = model || GP.DEFAULT_MODEL;
  const plan = [{ m: primary, tries: 3 }];
  if (GP.FALLBACK_MODEL && GP.FALLBACK_MODEL !== primary) plan.push({ m: GP.FALLBACK_MODEL, tries: 2 });
  const waits = [4000, 12000];
  let lastErr = null;
  for (let p = 0; p < plan.length; p++) {
    if (p > 0) {
      log('Gemini: ' + primary + ' is not answering (' + ((lastErr && lastErr.message) || 'error').slice(0, 140) +
          ') - falling back to ' + plan[p].m);
    }
    for (let t = 1; t <= plan[p].tries; t++) {
      try {
        const text = await callGeminiOnce(apiKey, plan[p].m, prompt, json);
        if (p > 0 || t > 1) log('Gemini: ' + plan[p].m + ' answered on attempt ' + t);
        return text;
      } catch (e) {
        lastErr = e;
        if (!e.retryable) throw e; // wrong key, unknown model, empty answer: retrying will not help
        const why = e.status === 503 ? 'high demand (503)'
          : e.status === 429 ? 'rate limited (429)'
          : e.status ? 'HTTP ' + e.status : 'network error';
        const moreOnThisModel = t < plan[p].tries;
        const moreModels = p < plan.length - 1;
        if (moreOnThisModel || moreModels) {
          const w = waits[Math.min(t - 1, waits.length - 1)];
          log('Gemini ' + why + ' on ' + plan[p].m + ' (attempt ' + t + ') - ' +
              (moreOnThisModel ? 'retrying in ' + (w / 1000) + 's' : 'trying another model next'));
          await sleep(w);
        }
      }
    }
  }
  throw lastErr || new Error('Gemini failed on all models');
}

function parseJsonFrom(text) {
  // Gemini sometimes wraps JSON in ``` fences - strip and extract.
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.search(/[\[{]/);
  const end = Math.max(cleaned.lastIndexOf(']'), cleaned.lastIndexOf('}'));
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON found in Gemini answer');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/* ---------------- notifications ---------------- */

function notify(id, title, message) {
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message: (message || '').slice(0, 300),
    priority: 1
  }, () => { if (chrome.runtime.lastError) log('notification error: ' + chrome.runtime.lastError.message); });
}

/* ---------------- "waiting on your reply" reminders ----------------
   Works entirely off the chat list the content script harvested. The rule:
   the chat's last message is not yours ("You:" prefix missing) AND that
   message is older than the threshold (default 3 days). One digest
   notification names the top few - never one notification per chat. */

async function runUnrepliedCheck(reason) {
  await purgeOldData(Object.assign({}, SETTINGS_DEFAULTS,
    (await getAll([GP.STORE.SETTINGS]))[GP.STORE.SETTINGS] || {})).catch(() => {});
  const d = await getAll([GP.STORE.SETTINGS, GP.STORE.CHATLIST, GP.STORE.UNR, GP.STORE.INSTALL, GP.STORE.MUTES]);
  const settings = Object.assign({
    unrepliedDays: GP.DEFAULT_UNREPLIED_DAYS,
    unrepliedNudgeHours: GP.DEFAULT_NUDGE_HOURS,
    unrepliedAlerts: true, importantNames: '', unrepliedMuteNames: '',
    windowDays: GP.DEFAULT_WINDOW_DAYS
  }, d[GP.STORE.SETTINGS] || {});
  const chatlist = d[GP.STORE.CHATLIST] || {};
  const plan = gpPlan(settings, d[GP.STORE.INSTALL] || Date.now());
  if (!plan.unreplied) {
    await setAll({ [GP.STORE.UNRLIST]: { at: Date.now(), items: [] } });
    return { ok: true, items: [], known: Object.keys(chatlist).length, locked: true,
      note: 'Reply reminders are a Pro feature (your free trial ended).' };
  }
  const mutes = d[GP.STORE.MUTES] || {};
  const unr = d[GP.STORE.UNR] && typeof d[GP.STORE.UNR] === 'object'
    ? d[GP.STORE.UNR] : { snooze: {}, dismiss: {} };
  unr.snooze = unr.snooze || {}; unr.dismiss = unr.dismiss || {};

  const now = Date.now();
  const computed = gpComputeUnreplied(chatlist, settings, unr, now);
  const st = computed.stats || {};
  const items = computed.filter((i) => { const m = gpMuteState(mutes, i.name, now); return !m || (m.mode === 'mentions' && i.mention); });
  items.stats = st;
  await chrome.storage.local.set({ [GP.STORE.UNRLIST]: { at: now, items } });

  const known = Object.keys(chatlist).length;
  log('reply-reminder (' + reason + '): ' + items.length + ' waiting after filters, ' + known + ' known. ' +
      'Skipped: ' + (st.skippedUnsavedNumber || 0) + ' unsaved-number, ' + (st.skippedPromo || 0) + ' promo/bulk, ' +
      (st.skippedSilentGroup || 0) + ' groups you never wrote in, ' + (st.skippedExcluded || 0) + ' excluded, ' +
      (st.skippedBroken || 0) + ' unloadable-message, ' + (st.skippedPayment || 0) + ' payment-link, ' +
      (st.skippedOld || 0) + ' older than ' + (settings.windowDays || GP.DEFAULT_WINDOW_DAYS) + ' days.');
  if (!items.length) {
    log('reply-reminder (' + reason + '): nothing waiting past ' + settings.unrepliedDays +
        ' day(s). (' + known + ' chats known from the chat list)');
    return { ok: true, items: [], known };
  }

  if (settings.unrepliedAlerts === false) {
    return { ok: true, items, known, note: 'notifications for reply reminders are off in Settings' };
  }

  // Decide whether to notify: always when the top list CHANGED; otherwise a
  // gentle repeat nudge every `unrepliedNudgeHours`, capped per day.
  const top = items.slice(0, 3);
  const sig = top.map(i => i.name + ':' + i.days).join('|') + '#' + items.length;
  const today = new Date().toDateString();
  if (unr.nudgeDay !== today) { unr.nudgeDay = today; unr.nudgeCount = 0; }
  const nudgeMs = Math.max(1, parseInt(settings.unrepliedNudgeHours, 10) || GP.DEFAULT_NUDGE_HOURS) * 3600e3;
  const changed = sig !== unr.lastDigestSig;
  const dueNudge = now - (unr.lastNotifyTs || 0) >= nudgeMs;

  if (!changed && !dueNudge) {
    return { ok: true, items, known, note: 'same top list, next nudge not due yet' };
  }
  if (!changed && dueNudge && (unr.nudgeCount || 0) >= GP.MAX_NUDGES_PER_DAY) {
    log('reply-reminder: daily nudge cap (' + GP.MAX_NUDGES_PER_DAY + ') reached, staying quiet');
    return { ok: true, items, known, note: 'daily nudge cap reached - quiet until tomorrow' };
  }

  notify('gp-unreplied',
    'GroupPing: ' + items.length + ' chat' + (items.length === 1 ? '' : 's') + ' waiting on your reply',
    top.map(i => i.name + ' (' + i.days + 'd' + (i.mention ? ', @you' : '') + ')').join(', ') +
      (items.length > 3 ? ' +' + (items.length - 3) + ' more' : ''));
  unr.lastDigestSig = sig;
  unr.lastNotifyTs = now;
  unr.nudgeCount = (unr.nudgeCount || 0) + 1;
  await chrome.storage.local.set({ [GP.STORE.UNR]: unr });
  log('reply-reminder (' + reason + '): notified about top ' + top.length + ' of ' + items.length + ' waiting chat(s)');
  return { ok: true, items, known, notified: true };
}

/* Snooze: hide this chat from the list and alerts for `hours` hours.
   Dismiss: hide it until a NEWER message arrives in that chat. */
async function unrAction(kind, name, hours) {
  const d = await getAll([GP.STORE.UNR, GP.STORE.CHATLIST]);
  const unr = d[GP.STORE.UNR] && typeof d[GP.STORE.UNR] === 'object' ? d[GP.STORE.UNR] : {};
  unr.snooze = unr.snooze || {}; unr.dismiss = unr.dismiss || {};
  if (kind === 'snooze') {
    unr.snooze[name] = Date.now() + Math.max(1, hours || 24) * 3600e3;
  } else if (kind === 'dismiss') {
    const entry = (d[GP.STORE.CHATLIST] || {})[name];
    unr.dismiss[name] = (entry && entry.lastTs) || Date.now();
  } else if (kind === 'clear') {
    delete unr.snooze[name]; delete unr.dismiss[name];
  }
  await chrome.storage.local.set({ [GP.STORE.UNR]: unr });
  return runUnrepliedCheck(kind + ' "' + name + '"');
}


/* ---------------- WhatsApp tab helpers ---------------- */

function queryWhatsAppTabs() {
  return new Promise((resolve) => {
    try { chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }, (t) => resolve(t || [])); }
    catch (e) { resolve([]); }
  });
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (r) => {
        if (chrome.runtime.lastError) resolve(null); else resolve(r || null);
      });
    } catch (e) { resolve(null); }
  });
}

/* Is a live GroupPing content script in this tab? Null answer means either no
   script (tab open since before install/update) or a stale one. */
async function pingTab(tabId) {
  const r = await sendToTab(tabId, { type: 'gp-ping' });
  return !!(r && r.ok);
}

async function waitForContentScript(tabId, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(1500);
    if (await pingTab(tabId)) return true;
  }
  return false;
}

/* ---------------- message store (single writer) ---------------- */

/* Merge messages sent by the content script. A message id is remembered in
   g.seen for 7 days even after the message itself is pruned, so a message can
   never be re-added (and therefore never re-sent to Gemini). */
function storeBatch(batches) {
  return withLock(async () => {
    const d = await getAll([GP.STORE.MSGS, GP.STORE.SETTINGS, GP.STORE.SELGROUPS, GP.STORE.CHATLIST]);
    const store = d[GP.STORE.MSGS] && typeof d[GP.STORE.MSGS] === 'object' ? d[GP.STORE.MSGS] : {};
    const selected = gpSelectedGroups(d[GP.STORE.SELGROUPS]);
    const chatlist = d[GP.STORE.CHATLIST] || {};
    const now = Date.now();
    const windowStart = gpWindowStart(d[GP.STORE.SETTINGS] || {}, now);
    let added = 0, refused = 0, dropped = 0;
    (batches || []).forEach((b) => {
      if (!b || !b.group || gpIsExcludedChat(b.group)) return;
      /* PRIVACY gates (the content script checks too; this is the final say):
         only groups the user turned on, positively known to be groups. */
      if (!selected.has(b.group)) { refused++; return; }
      const known = chatlist[b.group];
      /* STRICT (v0.5.4): the chat must be positively known as a group - from
         the Groups filter or an open verification. Unknown or ambiguous is
         refused here too, not just by the content script. */
      if (!known || known.isGroup !== true || known.notGroupAt) { refused++; return; }
      /* v0.5.8: message ids are unique per group. If this batch carries ids already
         stored under ANOTHER group, it was read from the wrong chat - refuse it. */
      let crossDup = 0, crossOwner = '';
      Object.keys(store).forEach((og) => {
        if (og === b.group) return;
        const sn = store[og].seen || {};
        (b.messages || []).forEach((m) => { if (m && m.id && sn[m.id]) { crossDup++; crossOwner = og; } });
      });
      if (crossDup) { refused++; log('privacy/accuracy: refused a batch for "' + b.group + '" - ' + crossDup + ' of its messages are already stored under "' + crossOwner + '" (wrong-chat read)'); return; }
      const g = store[b.group] || { messages: [], seen: {} };
      g.seen = g.seen || {};
      (b.messages || []).forEach((m) => {
        if (!m || !m.id || g.seen[m.id]) return;
        g.seen[m.id] = now;
        const at = gpParseMsgTime(m.timeText) || now;
        if (at < windowStart) return; // older than the look-back window: never stored, never sent to Gemini
        const red = gpRedactText(m.text);
        if (red.dropped) { dropped++; return; } // OTP/bank/credentials: never stored
        g.messages.push({ id: m.id, sender: m.sender, timeText: m.timeText, text: red.text, ts: now, at, scanned: false });
        added++;
      });
      g.messages.sort((a, b2) => a.at - b2.at);
      g.updated = now;
      store[b.group] = g;
    });
    if (added || (batches || []).length) {
      pruneStore(store, now, windowStart);
      await setAll({ [GP.STORE.MSGS]: store });
    }
    if (refused) log('privacy: refused to store messages from ' + refused + ' unselected/non-group batch(es)');
    if (dropped) log('privacy: dropped ' + dropped + ' sensitive message(s) (OTP/bank/credentials) before storing');
    return added;
  });
}

function pruneStore(store, now, windowStart) {
  const keepFrom = now - GP.MSG_KEEP_DAYS * 86400000;
  Object.keys(store).forEach((name) => {
    const g = store[name];
    g.messages = (g.messages || []).filter((m) => {
      const at = m.at || m.ts;
      if (windowStart && at < windowStart) return false; // outside the look-back window: purge even if never scanned
      return at >= keepFrom || !m.scanned;
    });
    if (g.messages.length > GP.MSG_KEEP_PER_CHAT) g.messages.splice(0, g.messages.length - GP.MSG_KEEP_PER_CHAT);
    Object.keys(g.seen || {}).forEach((id) => { if (g.seen[id] < now - 7 * 86400000) delete g.seen[id]; });
    if (!g.messages.length && Object.keys(g.seen || {}).length === 0) delete store[name];
  });
  const names = Object.keys(store);
  if (names.length > GP.MAX_CHATS_STORED) {
    names.sort((a, b) => (store[a].updated || 0) - (store[b].updated || 0));
    names.slice(0, names.length - GP.MAX_CHATS_STORED).forEach(n => delete store[n]);
  }
}

/* ---------------- look-back window purge ----------------
   Deletes everything older than the window (setting, default 30 days):
   chat-list rows, stored messages, found items, summaries, reply-list entries.
   Runs on startup and before every scan, so old data from earlier versions
   disappears on its own and changing the setting applies on the next scan. */
async function purgeOldData(settings) {
  return withLock(async () => {
    const now = Date.now();
    const windowStart = gpWindowStart(settings, now);
    const d = await getAll([GP.STORE.CHATLIST, GP.STORE.MSGS, GP.STORE.EVENTS, GP.STORE.SUMMARIES, GP.STORE.UNRLIST, GP.STORE.DIGESTS]);
    let droppedChats = 0, droppedEvents = 0, droppedSummaries = 0, droppedUnr = 0;

    const chatlist = d[GP.STORE.CHATLIST] || {};
    Object.keys(chatlist).forEach((n) => {
      const e = chatlist[n];
      const stamp = (e && e.lastTs) || (e && e.seenAt) || 0;
      if (stamp && stamp < windowStart) { delete chatlist[n]; droppedChats++; }
    });

    const store = d[GP.STORE.MSGS] || {};
    pruneStore(store, now, windowStart);

    const events = (d[GP.STORE.EVENTS] || []).filter((e) => {
      const stamp = e.whenTs || e.foundAt || 0;
      if (stamp && stamp < windowStart) { droppedEvents++; return false; }
      return true;
    });

    const summaries = d[GP.STORE.SUMMARIES] || {};
    Object.keys(summaries).forEach((k) => {
      const ts = new Date(k + 'T23:59:59').getTime();
      if (!isNaN(ts) && ts < windowStart) { delete summaries[k]; droppedSummaries++; }
    });

    let unrl = d[GP.STORE.UNRLIST];
    if (unrl && Array.isArray(unrl.items)) {
      const kept = unrl.items.filter((i) => { const old = i.lastTs && i.lastTs < windowStart; if (old) droppedUnr++; return !old; });
      unrl = { at: unrl.at, items: kept };
    }

    const digests = d[GP.STORE.DIGESTS] || {};
    Object.keys(digests).forEach((g) => { if (digests[g] && digests[g].at && digests[g].at < windowStart) delete digests[g]; });

    await setAll({ [GP.STORE.CHATLIST]: chatlist, [GP.STORE.MSGS]: store, [GP.STORE.EVENTS]: events,
      [GP.STORE.SUMMARIES]: summaries, [GP.STORE.UNRLIST]: unrl, [GP.STORE.DIGESTS]: digests });
    if (droppedChats || droppedEvents || droppedSummaries || droppedUnr) {
      log('window purge (' + (settings.windowDays || GP.DEFAULT_WINDOW_DAYS) + ' days): removed ' + droppedChats + ' old chat(s), ' +
          droppedEvents + ' old item(s), ' + droppedSummaries + ' old summary(ies), ' + droppedUnr + ' old reply entrie(s)');
    }
  });
}

/* ---------------- who is monitored (mutes + Free-plan group limit) ---------------- */

function monitoredSet(names, chatlist, mutes, plan, now, selected) {
  const sel = selected || new Set();
  const active = names.filter(n => sel.has(n) && !gpIsExcludedChat(n) &&
    !(gpMuteState(mutes, n, now) && gpMuteState(mutes, n, now).mode === 'all'));
  if (plan.maxGroups === Infinity) return new Set(active);
  active.sort((a, b) => ((chatlist[b] && chatlist[b].lastTs) || 0) - ((chatlist[a] && chatlist[a].lastTs) || 0));
  return new Set(active.slice(0, plan.maxGroups));
}

function groupNames(msgStore, chatlist) {
  const out = new Set(Object.keys(msgStore || {}));
  Object.keys(chatlist || {}).forEach((n) => {
    if (chatlist[n] && chatlist[n].notGroupAt) { out.delete(n); return; }  // open-verified NON-group: never listed
    if (chatlist[n] && chatlist[n].isGroup) out.add(n);
  });
  return Array.from(out).filter(n => !gpIsExcludedChat(n));
}

/* ---------------- scan: plans / events / decisions / deadlines / requests ---------------- */

const SCAN_CHAR_BUDGET = 14000;   // ~3.5k tokens per Gemini call
const MAX_CALLS_PER_SCAN = 3;     // protects the free tier; leftovers wait for the next scan

function compactTime(tt) { const m = String(tt || '').match(/\d{1,2}:\d{2}\s?[ap]?m?/i); return m ? m[0].replace(/\s/g, '') : ''; }

function buildScanPrompt(chunks, openItems) {
  const now = new Date();
  const hdr = [
    'Today is ' + now.toDateString() + ', ' + now.toTimeString().slice(0, 5) + ' local. "You" is the user.',
    'These are new messages from the user\'s WhatsApp groups. Find ONLY concrete, actionable things:',
    '- events or plans with a real date or time (who proposed it, where, when),',
    '- deadlines, submissions, exams (what exactly, and when),',
    '- decisions the group actually reached (what was decided, not options still being discussed),',
    '- questions or requests aimed at the user that are still unanswered (who asked, what they need).',
    'IGNORE: greetings, jokes, memes, stickers, forwards, promos, ads, vague talk with no date and no ask, anything the user already answered.',
    'Return ONLY a JSON object ({"items":[],"digest":[]} if none).',
    'items: the individual important things found - EVERY plan, deadline, decision and unanswered question, each its own entry. Item keys:',
    'g group, id existing id or null, t title (max 6 words), k "event"|"decision"|"deadline"|"reply",',
    'd "YYYY-MM-DD" or null, tm "HH:MM" 24h or null, loc place or null, s one short line naming WHO proposed or asked WHAT and what is confirmed vs still pending (example: "A game was proposed for this evening; the venue is still unconfirmed"),',
    'y going count, m maybe count, n not-sure count (numbers or null), me true if the user already replied or confirmed,',
    'at true if the user is @mentioned or directly asked, from sender, km up to 3 key messages as [["sender","text"],...].',
    'Resolve relative words ("tomorrow", "Friday", "next week") into real dates using today. Only keep items with a real date/time hint or an unanswered request. If a message updates an open item below, reuse its id.',
    'digest: one entry per group above: {"g":group,"discussed":"one short line - what the group talked about","plan":"one short line - what the plan is (or null)","decision":"one short line - the final conclusion, or the exact text still undecided"}.',
    'Groups marked [digest only] had no obvious plan/request: for them return ONLY the digest entry (still return an item if you spot something concrete). Every group below MUST get a digest entry.'
  ];
  if (openItems.length) hdr.push('Open items (id|group|title):\n' + openItems.map(i => i.id + '|' + i.group + '|' + i.title).join('\n'));
  let body = '';
  chunks.forEach((c) => {
    body += '\n## ' + c.group + (c.digestOnly ? ' [digest only]' : '') + '\n';
    c.msgs.forEach((m) => { body += '[' + (compactTime(m.timeText) ? compactTime(m.timeText) + ' ' : '') + m.sender + '] ' + m.text + '\n'; });
  });
  return hdr.join('\n') + '\nMessages:' + body;
}

/* Collect never-scanned messages per monitored chat. Chats whose new messages
   contain no plan/time/request hint are marked scanned WITHOUT any Gemini call. */
function selectUnscanned(store, monitored, mutes, now, windowStart) {
  const chunks = [], skipIds = {}, allIds = {};
  let skippedChats = 0, skippedOld = 0;
  Object.keys(store).forEach((name) => {
    if (!monitored.has(name)) return;
    const allFresh = (store[name].messages || []).filter(m => !m.scanned);
    if (!allFresh.length) return;
    allIds[name] = allFresh.map(m => m.id);
    // messages older than the look-back window are marked scanned WITHOUT any
    // Gemini call - old history is never analysed.
    const tooOld = allFresh.filter(m => (m.at || m.ts) < windowStart);
    const fresh = allFresh.filter(m => (m.at || m.ts) >= windowStart);
    if (tooOld.length) { skipIds[name] = (skipIds[name] || []).concat(tooOld.map(m => m.id)); skippedOld += tooOld.length; }
    if (!fresh.length) return;
    const ms = gpMuteState(mutes, name, now);
    const hasSignal = fresh.some(m => gpHasSignal(m.text));
    /* v0.5.6: a chatter-only chat is no longer skipped - it still gets its
       per-group summary (digest) from the same Gemini call, trimmed short so
       it barely costs anything. The user asked for a summary of EVERY
       selected group, not only the plan-like ones. */
    if (!hasSignal) {
      const trimmedQuiet = fresh.slice(-20).map(m => ({ id: m.id, sender: m.sender, timeText: m.timeText, text: m.text.replace(/\s+/g, ' ').slice(0, 140) }));
      chunks.push({ group: name, msgs: trimmedQuiet, ids: fresh.map(m => m.id), mentionsOnly: !!(ms && ms.mode === 'mentions'), digestOnly: true });
      skippedChats++;
      return;
    }
    const trimmed = fresh.slice(-60).map(m => ({ id: m.id, sender: m.sender, timeText: m.timeText, text: m.text.replace(/\s+/g, ' ').slice(0, 240) }));
    chunks.push({ group: name, msgs: trimmed, ids: fresh.map(m => m.id), mentionsOnly: !!(ms && ms.mode === 'mentions') });
  });
  return { chunks, skipIds, skippedChats, skippedOld };
}

function markScanned(store, idsByGroup) {
  Object.keys(idsByGroup).forEach((name) => {
    const set = new Set(idsByGroup[name]);
    ((store[name] || {}).messages || []).forEach((m) => { if (set.has(m.id)) m.scanned = true; });
  });
}

function itemId(group, title, date, time) {
  return (group + '|' + String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + '|' + (date || '') + '|' + (time || '')).slice(0, 160);
}

function mergeItems(stored, found, now, settings) {
  const fresh = [];
  const byId = new Map(stored.map(e => [e.id, e]));
  found.forEach((e) => {
    if (!e || typeof e !== 'object') return;
    const group = String(e.g || e.group || '');
    if (!group || gpIsExcludedChat(group)) return;
    const kind = ['event', 'decision', 'deadline', 'reply'].includes(e.k) ? e.k : 'event';
    const title = String(e.t || e.title || 'Plan').slice(0, 80);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(e.d || '') ? e.d : null;
    const time = /^\d{1,2}:\d{2}$/.test(e.tm || '') ? e.tm : null;
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    const km = Array.isArray(e.km) ? e.km.slice(0, 3).map(k => ({ sender: String(k[0] || '').slice(0, 40), text: String(k[1] || '').slice(0, 220) })) : [];
    let ex = e.id && byId.get(e.id);
    if (!ex) ex = byId.get(itemId(group, title, date, time));
    const fields = {
      group, title, kind, date, time, whenTs: gpWhenTs(date, time), location: e.loc || null,
      summary: String(e.s || '').slice(0, 240), going: num(e.y), maybe: num(e.m), unsure: num(e.n),
      userReplied: e.me === true, mentionsYou: e.at === true, sender: String(e.from || '').slice(0, 60), keyMessages: km
    };
    if (ex) {
      Object.keys(fields).forEach((k) => { if (fields[k] !== null && fields[k] !== '' && !(Array.isArray(fields[k]) && !fields[k].length)) ex[k] = fields[k]; });
      ex.updatedAt = now;
      if (ex.userReplied && ex.kind === 'reply') ex.state = 'resolved';
      return;
    }
    if (kind === 'reply' && fields.userReplied) return; // nothing pending
    const ev = Object.assign({ id: itemId(group, title, date, time), foundAt: now, updatedAt: now, state: 'open', reminded: false, snoozeUntil: 0 }, fields);
    stored.push(ev); byId.set(ev.id, ev); fresh.push(ev);
  });
  return fresh;
}

let scanRunning = false;

/* The hourly job: read chats in the WhatsApp tab, then analyse only new messages. */
/* v0.5.10: a community ticked earlier (or by an older version) is swapped for its subgroups before every scan. */
async function expandSelectedCommunities() {
  const d = await getAll([GP.STORE.SELGROUPS, GP.STORE.CHATLIST]);
  const ex = gpExpandCommunities(d[GP.STORE.SELGROUPS] || {}, d[GP.STORE.CHATLIST] || {});
  const cs = Object.keys(ex.expanded);
  if (!cs.length) return '';
  await setAll({ [GP.STORE.SELGROUPS]: ex.sel });
  const note = cs.map(c => 'Community "' + c + '" replaced by its ' + ex.expanded[c].length + ' subgroup(s): ' + ex.expanded[c].join(', ')).join('; ');
  log(note);
  return note;
}

async function fullScan(reason) {
  if (scanRunning) return { ok: true, running: true, note: 'A scan is already running - it will finish by itself.' };
  scanRunning = true;
  const keepAlive = setInterval(() => { chrome.storage.local.get('gp_ka', () => {}); }, 20000); // keeps the worker awake during a long scan
  try {
    await setAll({ [GP.STORE.STATUS]: { at: Date.now(), reason, scanning: true } });
    const { settings } = await getSettings();
    await purgeDuplicateGroups().catch((e) => log('duplicate cleanup error: ' + e.message));
    const communityNote = await expandSelectedCommunities().catch((e) => { log('community expand error: ' + e.message); return ''; });
    await purgeOldData(settings).catch((e) => log('window purge error: ' + e.message));
    const tabs = await queryWhatsAppTabs();
    let read = null;
    if (!tabs.length) {
      log('scan (' + reason + '): WhatsApp Web is not open in any tab. Open web.whatsapp.com and keep it open.');
    } else {
      read = await pullFromTabs(settings);
    }
    const r = await runScan(reason);
    await runUnrepliedCheck('after scan').catch(() => {});
    // a failed read (tab not attachable) is more important than "nothing new":
    // never hide it behind the analysis note.
    if (read && read.note && (read.ok === false || !r.note)) r.note = read.note;
    /* v0.5.7: groups opened but zero messages stored means the read pipeline
       itself is broken - say so plainly instead of "nothing to summarise". */
    if (read && read.ok && (read.opened || 0) > 0 && !r.found && !r.calls) {
      r.note = 'Groups opened but no messages could be read from them. Run Settings > General > Run self-test and send the Debug log - this should not happen.';
    }
    if (!tabs.length) r.note = 'WhatsApp Web is not open in any tab. Open web.whatsapp.com first.';
    r.read = read;
    const st = { at: Date.now(), reason, scanning: false, ok: r.ok !== false,
      note: ((communityNote ? communityNote + '. ' : '') + (r.note || '')), found: r.found || 0, calls: r.calls || 0,
      readOk: !!(read && read.ok), chats: read && read.count, groups: read && read.groups,
      opened: read && read.opened, failed: read && read.failures, deep: read && read.deep,
      groupStatus: (read && read.groupStatus) || null, selectedTotal: read && read.selectedOnly ? read.groups : null };
    await setAll({ [GP.STORE.STATUS]: st, [GP.STORE.LASTSCAN]: st.at });
    log('scan (' + reason + ') finished: ' + (st.readOk ? 'read ok' : 'NO READ') +
        (st.groups != null ? ', ' + st.groups + ' groups known' : '') +
        (st.found ? ', ' + st.found + ' new item(s)' : '') + (st.note ? ' - ' + st.note : ''));
    return r;
  } finally { scanRunning = false; clearInterval(keepAlive); }
}

/* Ask the open WhatsApp Web tab to collect messages right now, so a scan does
   not just wait for the content script's own timer. If no tab has a live
   content script - normal right after install/update, because Chrome only
   injects into tabs loaded afterwards - reload one tab, wait for the script,
   and retry. Last resort: inject the script programmatically. Every step is
   logged, so the Debug log explains itself. */
async function pullFromTabs(settings) {
  const tabs = await queryWhatsAppTabs();
  const msg = { type: 'gp-read-all', deepRead: settings.deepRead !== false && !settings.localOnly, max: GP.MAX_DEEP_READ };
  for (const tab of tabs) {
    if (!(await pingTab(tab.id))) continue;
    const r = await sendToTab(tab.id, msg);
    if (r && r.ok) return r;
    if (r && r.error) return { ok: false, note: r.error };
  }
  log('no live GroupPing content script in any WhatsApp tab - reloading the tab to fix it (this is needed once after install/update)');
  const tab = tabs[0];
  await new Promise((res) => { try { chrome.tabs.reload(tab.id, {}, () => res()); } catch (e) { res(); } });
  if (await waitForContentScript(tab.id, 30000)) {
    log('content script connected after reloading the WhatsApp tab');
    const r = await sendToTab(tab.id, msg);
    if (r && r.ok) return Object.assign({ reloaded: true }, r);
    if (r && r.error) return { ok: false, note: r.error };
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['shared.js', 'content.js'] });
    if (await waitForContentScript(tab.id, 8000)) {
      log('content script injected directly into the WhatsApp tab');
      const r = await sendToTab(tab.id, msg);
      if (r && r.ok) return Object.assign({ injected: true }, r);
      if (r && r.error) return { ok: false, note: r.error };
    }
  } catch (e) { log('direct injection failed: ' + e.message); }
  return { ok: false, note: 'GroupPing could not attach to the WhatsApp tab. Click the WhatsApp tab, press F5 once, then scan again.' };
}

async function runScan(reason) {
  const { settings, installTs } = await getSettings();
  const plan = gpPlan(settings, installTs);
  if (!settings.geminiKey && !settings.localOnly) {
    log('scan skipped: no Gemini API key.');
    notify('gp-nokey', 'GroupPing needs your Gemini API key', 'Open the GroupPing popup and paste your free key from aistudio.google.com.');
    return { ok: false, error: 'no Gemini API key' };
  }
  const d = await getAll([GP.STORE.MSGS, GP.STORE.CHATLIST, GP.STORE.MUTES, GP.STORE.EVENTS, GP.STORE.SELGROUPS, GP.STORE.DIGESTS]);
  const store = d[GP.STORE.MSGS] || {};
  const chatlist = d[GP.STORE.CHATLIST] || {};
  const mutes = d[GP.STORE.MUTES] || {};
  const selected = gpSelectedGroups(d[GP.STORE.SELGROUPS]);
  const now = Date.now();
  const windowStart = gpWindowStart(settings, now);
  const monitored = monitoredSet(groupNames(store, chatlist), chatlist, mutes, plan, now, selected);
  const sel = selectUnscanned(store, monitored, mutes, now, windowStart);

  /* PRIVACY: local-only mode never calls Gemini. Collected messages are
     marked handled and left to expire; reply reminders (chat-list metadata
     only) keep working. */
  if (settings.localOnly) {
    const all = Object.assign({}, sel.skipIds);
    Object.keys(store).forEach((n) => { all[n] = (all[n] || []).concat((store[n].messages || []).filter(m => !m.scanned).map(m => m.id)); });
    if (Object.keys(all).length) {
      await withLock(async () => {
        const cur = (await getAll([GP.STORE.MSGS]))[GP.STORE.MSGS] || {};
        markScanned(cur, all);
        pruneStore(cur, now, windowStart);
        await setAll({ [GP.STORE.MSGS]: cur });
      });
    }
    log('scan (' + reason + '): local-only mode - no Gemini calls, messages not analysed');
    return { ok: true, found: 0, calls: 0, note: 'Local-only mode: nothing was analysed or sent anywhere. Reply reminders still work.' };
  }

  // chats with nothing worth analysing: mark scanned, no tokens spent
  if (Object.keys(sel.skipIds).length) {
    await withLock(async () => {
      const cur = (await getAll([GP.STORE.MSGS]))[GP.STORE.MSGS] || {};
      markScanned(cur, sel.skipIds);
      await setAll({ [GP.STORE.MSGS]: cur });
    });
  }
  await markDayScanned(Object.keys(store).filter(n => monitored.has(n)));

  if (!sel.chunks.length) {
    const nothingNew = 'No new messages in your selected groups - nothing to summarise or plan yet.';
    log('scan (' + reason + '): no new messages to analyse' + (sel.skippedOld ? ' (' + sel.skippedOld + ' message(s) older than ' + (settings.windowDays || GP.DEFAULT_WINDOW_DAYS) + ' days ignored)' : '') + ' - no Gemini call');
    return { ok: true, found: 0, calls: 0, note: nothingNew };
  }

  // pack chats into batched calls under the character budget
  const batches = []; let cur = [], size = 0;
  sel.chunks.forEach((c) => {
    const sz = c.msgs.reduce((n, m) => n + m.text.length + m.sender.length + 12, 0) + c.group.length + 6;
    if (cur.length && size + sz > SCAN_CHAR_BUDGET) { batches.push(cur); cur = []; size = 0; }
    cur.push(c); size += sz;
  });
  if (cur.length) batches.push(cur);

  let stored = d[GP.STORE.EVENTS] || [];
  let freshAll = [], calls = 0, lastErr = null, digestsUpdated = 0;
  for (const batch of batches.slice(0, MAX_CALLS_PER_SCAN)) {
    const openItems = stored.filter(e => e.state === 'open' && batch.some(c => c.group === e.group)).slice(-8);
    let found;
    let digestFound = [];
    try {
      calls++;
      const answer = await callGemini(settings.geminiKey, settings.model || GP.DEFAULT_MODEL, buildScanPrompt(batch, openItems), true);
      const parsed = parseJsonFrom(answer);
      if (Array.isArray(parsed)) found = parsed; // older prompt shape
      else {
        found = Array.isArray(parsed.items) ? parsed.items : [];
        digestFound = Array.isArray(parsed.digest) ? parsed.digest : [];
      }
    } catch (e) {
      lastErr = e; log('Gemini/parse error: ' + e.message + ' - these messages stay unscanned and are retried next scan');
      continue; // cursor NOT advanced: nothing lost, nothing double-counted
    }
    // mentions-only mute: keep only items that address the user
    const mentionOnly = new Set(batch.filter(c => c.mentionsOnly).map(c => c.group));
    found = found.filter(f => !mentionOnly.has(String(f.g || f.group || '')) || f.at === true);
    const fresh = mergeItems(stored, found, Date.now(), settings);
    freshAll = freshAll.concat(fresh);
    const ids = {}; batch.forEach(c => { ids[c.group] = c.ids; });
    const digestNow = Date.now();
    await withLock(async () => {
      const cs = (await getAll([GP.STORE.MSGS]))[GP.STORE.MSGS] || {};
      markScanned(cs, ids);
      const dg = (await getAll([GP.STORE.DIGESTS]))[GP.STORE.DIGESTS] || {};
      digestFound.forEach((x) => {
        const g = String((x && x.g) || '');
        if (!g || gpIsExcludedChat(g) || !selected.has(g)) return;
        digestsUpdated++;
        dg[g] = { at: digestNow, discussed: String(x.discussed || '').slice(0, 200),
          plan: x.plan ? String(x.plan).slice(0, 200) : null,
          decision: x.decision ? String(x.decision).slice(0, 200) : 'still undecided' };
      });
      await setAll({ [GP.STORE.MSGS]: cs, [GP.STORE.EVENTS]: stored.slice(-150), [GP.STORE.DIGESTS]: dg });
    });
  }
  stored = stored.slice(-150);
  stored.forEach((e) => scheduleReminder(e, settings));
  /* Plain words for the popup: what the scan did and why the plan may be
     empty. The user asked to always see WHY there is no action plan. */
  const note = freshAll.length
    ? freshAll.length + ' new update(s)' + (digestsUpdated ? ', summaries refreshed for ' + digestsUpdated + ' group(s)' : '') + '.'
    : digestsUpdated
      ? 'Nothing needs action, but summaries were refreshed for ' + digestsUpdated + ' group(s) - see them group by group below.'
      : 'Your groups were read but Gemini found nothing to summarise yet.';
  log('scan (' + reason + '): ' + calls + ' Gemini call(s), ' + freshAll.length + ' new item(s), ' + digestsUpdated + ' group summar(ies)');
  notifyFresh(freshAll, settings, mutes);
  if (lastErr && !calls) return { ok: false, error: lastErr.message };
  if (lastErr && !freshAll.length) return { ok: false, error: lastErr.message, calls };
  return { ok: true, found: freshAll.length, calls, events: freshAll, digests: digestsUpdated, note };
}

async function markDayScanned(names) {
  const d = await getAll([GP.STORE.DAYSTATS]);
  let s = d[GP.STORE.DAYSTATS];
  const day = gpDayKey();
  if (!s || s.day !== day) s = { day, scanned: {} };
  names.forEach(n => { s.scanned[n] = true; });
  await setAll({ [GP.STORE.DAYSTATS]: s });
}

/* One combined notification per scan (not one per item). */
function notifyFresh(fresh, settings, mutes) {
  if (!fresh.length || settings.eventAlerts === false) return;
  const tomorrow = gpDayKey(Date.now() + 86400000);
  const worth = fresh.filter((e) => {
    const m = gpMuteState(mutes, e.group, Date.now());
    if (m && !(m.mode === 'mentions' && e.mentionsYou)) return false;
    return !e.date || e.date <= tomorrow;
  });
  if (!worth.length) return;
  const first = worth[0];
  const when = first.date ? (' ' + (first.date === gpDayKey() ? 'today' : first.date) + (first.time ? ' ' + first.time : '')) : '';
  notify('gp-new-' + Date.now(),
    worth.length === 1 ? 'GroupPing: ' + first.title : 'GroupPing: ' + worth.length + ' new updates',
    worth.slice(0, 3).map(e => e.title + ' (' + e.group + ')').join('; ') + (worth.length === 1 ? when + (first.summary ? ' - ' + first.summary : '') : ''));
}

async function fireReminder(eventId) {
  const { settings } = await getSettings();
  await withLock(async () => {
    const stored = (await getAll([GP.STORE.EVENTS]))[GP.STORE.EVENTS] || [];
    const ev = stored.find(e => e.id === eventId);
    if (!ev || ev.reminded || ev.state === 'resolved') return;
    ev.reminded = true;
    await setAll({ [GP.STORE.EVENTS]: stored });
    const mins = parseInt(ev.remindMinutes || settings.remindMinutes || 60, 10);
    notify('gp-rem-' + ev.id, 'Reminder: ' + ev.title + (mins >= 60 ? ' in about ' + Math.round(mins / 60) + ' hr' : ' in ' + mins + ' min'),
      (ev.group || '') + (ev.time ? ' at ' + ev.time : '') + (ev.location ? ', ' + ev.location : ''));
    log('reminder fired for "' + ev.title + '"');
  });
}

async function fireSnooze(eventId) {
  const stored = (await getAll([GP.STORE.EVENTS]))[GP.STORE.EVENTS] || [];
  const ev = stored.find(e => e.id === eventId);
  if (!ev || ev.state === 'resolved') return;
  notify('gp-snz-' + ev.id, 'GroupPing reminder: ' + ev.title, (ev.group || '') + (ev.summary ? ' - ' + ev.summary : ''));
}

/* ---------------- evening: final scan + complete summary of the day ---------------- */

async function eveningRun() {
  const { settings } = await getSettings();
  await fullScan('evening');
  if (settings.eveningSummary !== false) return runEveningSummary();
  return { ok: true };
}

async function runEveningSummary() {
  const { settings, installTs } = await getSettings();
  const plan = gpPlan(settings, installTs);
  if (settings.localOnly) { log('evening summary skipped: local-only mode (no Gemini calls)'); return { ok: true, skipped: 'local-only' }; }
  if (!settings.geminiKey) { log('evening summary skipped: no Gemini API key'); return { ok: false, error: 'no Gemini API key' }; }
  const d = await getAll([GP.STORE.MSGS, GP.STORE.CHATLIST, GP.STORE.MUTES, GP.STORE.SUMMARIES, GP.STORE.SELGROUPS]);
  const store = d[GP.STORE.MSGS] || {}, chatlist = d[GP.STORE.CHATLIST] || {}, mutes = d[GP.STORE.MUTES] || {};
  const now = Date.now();
  const monitored = monitoredSet(groupNames(store, chatlist), chatlist, mutes, plan, now, gpSelectedGroups(d[GP.STORE.SELGROUPS]));
  const sod = gpStartOfDay(now);
  const todays = {};
  let total = 0;
  Object.keys(store).forEach((g) => {
    if (!monitored.has(g)) return;
    const ms = (store[g].messages || []).filter(m => (m.at || m.ts) >= sod && m.text && m.text.length > 1);
    if (ms.length) { todays[g] = ms; total += ms.length; }
  });
  const names = Object.keys(todays).sort((a, b) => todays[b].length - todays[a].length);
  if (!names.length) { log('evening summary: nothing collected today'); return { ok: true, groups: 0 }; }

  // pack into as few calls as possible (usually one)
  const batches = []; let cur = [], size = 0;
  names.forEach((g) => {
    const lines = todays[g].slice(-80).map(m => m.sender + ': ' + m.text.replace(/\s+/g, ' ').slice(0, 200));
    const sz = lines.join('\n').length + g.length;
    if (cur.length && size + sz > 28000) { batches.push(cur); cur = []; size = 0; }
    cur.push({ g, lines }); size += sz;
  });
  if (cur.length) batches.push(cur);

  const out = { overall: '', groups: {}, counts: {} };
  let failed = null;
  for (const batch of batches.slice(0, 3)) {
    const prompt = [
      'Summarise everything that happened today in these WhatsApp groups. "You" is the user.',
      'Return ONLY JSON: {"overall":"2 short sentences on the day across all groups","actionplan":["one short concrete to-do with its deadline, most urgent first, max 5"],"groups":{"<group>":["bullet",...]}}.',
      'Per group: 2-6 one-line bullets, plans/decisions/deadlines first, then notable discussion. No filler.',
      'actionplan: only real to-dos for the user from today (reply to X, submit Y by Friday, confirm Z), each with its deadline if one exists. [] if none.',
      batch.map(b => '## ' + b.g + '\n' + b.lines.join('\n')).join('\n')
    ].join('\n');
    try {
      const ans = parseJsonFrom(await callGemini(settings.geminiKey, settings.model || GP.DEFAULT_MODEL, prompt, true));
      if (ans.overall) out.overall += (out.overall ? ' ' : '') + ans.overall;
      if (Array.isArray(ans.actionplan)) out.actionplan = (out.actionplan || []).concat(ans.actionplan.map(a => String(a).slice(0, 160)));
      Object.assign(out.groups, ans.groups || {});
    } catch (e) { failed = e; log('summary error: ' + e.message); }
  }
  if (!Object.keys(out.groups).length) return { ok: false, error: failed ? failed.message : 'summary came back empty' };
  names.forEach((g) => { out.counts[g] = todays[g].length; });
  out.total = total;
  const all = d[GP.STORE.SUMMARIES] || {};
  all[gpDayKey(now)] = Object.assign({ at: now }, out);
  const keys = Object.keys(all).sort();
  while (keys.length > 14) delete all[keys.shift()];
  await setAll({ [GP.STORE.SUMMARIES]: all });
  notify('gp-summary-' + gpDayKey(now), 'GroupPing evening summary',
    (out.overall || ('Summary ready for ' + Object.keys(out.groups).length + ' groups.')).slice(0, 250));
  log('evening summary stored: ' + Object.keys(out.groups).length + ' group(s), ' + total + ' message(s)');
  return { ok: true, groups: Object.keys(out.groups).length };
}

/* ---------------- dashboard data for the popup ---------------- */

async function getDashboard() {
  const d = await getAll([GP.STORE.SETTINGS, GP.STORE.INSTALL, GP.STORE.EVENTS, GP.STORE.MSGS, GP.STORE.CHATLIST,
    GP.STORE.MUTES, GP.STORE.SUMMARIES, GP.STORE.UNRLIST, GP.STORE.DAYSTATS, GP.STORE.ONBOARD, GP.STORE.PROGRESS, GP.STORE.STATUS,
    GP.STORE.SELGROUPS, GP.STORE.DIGESTS]);
  const settings = Object.assign({}, SETTINGS_DEFAULTS, d[GP.STORE.SETTINGS] || {});
  const plan = gpPlan(settings, d[GP.STORE.INSTALL] || Date.now());
  const now = Date.now();
  const store = d[GP.STORE.MSGS] || {}, chatlist = d[GP.STORE.CHATLIST] || {}, mutes = d[GP.STORE.MUTES] || {};
  const names = groupNames(store, chatlist);
  const selected = gpSelectedGroups(d[GP.STORE.SELGROUPS]);
  const monitored = monitoredSet(names, chatlist, mutes, plan, now, selected);
  const sod = gpStartOfDay(now);
  const windowStart = gpWindowStart(settings, now);
  let messagesToday = 0;
  const volume = {}; // messages per selected group inside the look-back window
  Object.keys(store).forEach((g) => {
    if (!monitored.has(g)) return;
    const inWindow = (store[g].messages || []).filter(m => (m.at || m.ts) >= windowStart);
    volume[g] = inWindow.length;
    messagesToday += inWindow.filter(m => (m.at || m.ts) >= sod).length;
  });
  // "Most active": the selected groups with the most messages in the window
  const mostActive = Object.keys(volume).filter(g => volume[g] > 0)
    .sort((a, b) => volume[b] - volume[a]).slice(0, 5)
    .map(g => ({ name: g, count: volume[g] }));

  const visible = (d[GP.STORE.EVENTS] || []).filter((e) => {
    if (e.state !== 'open' || (e.snoozeUntil || 0) > now) return false;
    if (!monitored.has(e.group)) return false;
    // expired events (more than 3 hours past) drop off
    if (e.whenTs && e.kind !== 'reply' && e.whenTs < now - 3 * 3600e3) return false;
    return true;
  }).sort((a, b) => (a.whenTs || a.foundAt) - (b.whenTs || b.foundAt));
  const today = visible.filter(e => e.kind !== 'reply' && gpItemBucket(e, now) === 'today');
  const upcoming = visible.filter(e => e.kind !== 'reply' && gpItemBucket(e, now) === 'upcoming');
  const replyItems = visible.filter(e => e.kind === 'reply');
  const unrl = (d[GP.STORE.UNRLIST] && d[GP.STORE.UNRLIST].items) || [];
  const pending = replyItems.map(e => ({ source: 'ai', id: e.id, name: e.group, from: e.sender, preview: e.summary || (e.keyMessages[0] && e.keyMessages[0].text) || '',
      at: e.foundAt, priority: e.mentionsYou ? 'High' : 'Medium', item: e }))
    .concat(unrl.map(i => ({ source: 'chat', name: i.name, from: i.name, preview: i.preview, days: i.days, at: i.lastTs, priority: gpPriority(i), important: i.important })));
  const rank = { High: 0, Medium: 1, Low: 2 };
  pending.sort((a, b) => rank[a.priority] - rank[b.priority] || (a.at || 0) - (b.at || 0));

  const actionPlan = buildActionPlan(visible, unrl, now);
  const mutedList = Object.keys(mutes).map(n => ({ name: n, state: gpMuteState(mutes, n, now) })).filter(x => x.state);
  const groupsWithUpdates = new Set(today.map(e => e.group));
  const summaries = d[GP.STORE.SUMMARIES] || {};
  const skey = Object.keys(summaries).sort().pop();
  // Can GroupPing reach the WhatsApp tab right now? (drives the popup status line)
  const waTabs = await queryWhatsAppTabs();
  let connected = false;
  for (const t of waTabs) { if (await pingTab(t.id)) { connected = true; break; } }
  return {
    ok: true, now, plan, onboarded: !!d[GP.STORE.ONBOARD], hasKey: !!settings.geminiKey,
    localOnly: !!settings.localOnly, selectedCount: selected.size,
    connected, tabCount: waTabs.length, scanning: scanRunning, lastScan: d[GP.STORE.STATUS] || null,
    upgradeUrl: settings.upgradeUrl || '', scanMinutes: settings.scanMinutes,
    actionPlan, mostActive, digests: d[GP.STORE.DIGESTS] || {}, selectedNames: Array.from(selected),
    stats: {
      messages: messagesToday, updates: today.length + replyItems.length, groups: monitored.size,
      groupsQuiet: Math.max(0, monitored.size - groupsWithUpdates.size),
      events: today.filter(e => e.kind === 'event').length, decisions: today.filter(e => e.kind === 'decision').length,
      deadlines: today.filter(e => e.kind === 'deadline').length, needReply: pending.length
    },
    today, upcoming, pending, muted: mutedList,
    summary: skey ? Object.assign({ day: skey }, summaries[skey]) : null,
    progress: d[GP.STORE.PROGRESS] || null,
    knownGroups: names.length, lockedGroups: plan.maxGroups === Infinity ? 0 :
      Math.max(0, Array.from(selected).filter(n => !gpMuteState(mutes, n, now)).length - monitored.size)
  };
}

/* "What to do, by when": deadlines first, then people waiting on an answer,
   then today/tomorrow's events you have not confirmed. Derived locally from
   the items already found - no extra AI call. */
function buildActionPlan(visible, unrl, now) {
  now = now || Date.now();
  const today = gpDayKey(now), tomorrow = gpDayKey(now + 86400000);
  const out = [];
  const fmt = (dt) => dt === today ? 'today' : dt === tomorrow ? 'tomorrow' : dt;
  visible.filter(e => e.kind === 'deadline' && e.date).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3)
    .forEach(e => out.push({ text: e.title + ' - due ' + fmt(e.date), group: e.group, kind: 'deadline', id: e.id }));
  visible.filter(e => e.kind === 'reply').slice(0, 2)
    .forEach(e => out.push({ text: 'Reply to ' + (e.sender || 'the group') + (e.summary ? ': ' + e.summary.slice(0, 90) : ''), group: e.group, kind: 'reply', id: e.id }));
  (unrl || []).slice(0, 2)
    .forEach(i => out.push({ text: 'Reply in "' + i.name + '" - waiting ' + i.days + ' day' + (i.days === 1 ? '' : 's'), group: i.name, kind: 'reply' }));
  visible.filter(e => e.kind === 'event' && e.date && e.date <= tomorrow && !e.userReplied)
    .sort((a, b) => (a.whenTs || 0) - (b.whenTs || 0)).slice(0, 2)
    .forEach(e => out.push({ text: e.title + (e.time ? ' at ' + e.time : '') + ' ' + fmt(e.date) + ' - confirm if you are going', group: e.group, kind: 'event', id: e.id }));
  return out.slice(0, 6);
}

async function getGroupsList() {
  const d = await getAll([GP.STORE.SETTINGS, GP.STORE.INSTALL, GP.STORE.EVENTS, GP.STORE.MSGS, GP.STORE.CHATLIST, GP.STORE.MUTES, GP.STORE.SELGROUPS]);
  const settings = Object.assign({}, SETTINGS_DEFAULTS, d[GP.STORE.SETTINGS] || {});
  const plan = gpPlan(settings, d[GP.STORE.INSTALL] || Date.now());
  const store = d[GP.STORE.MSGS] || {}, chatlist = d[GP.STORE.CHATLIST] || {}, mutes = d[GP.STORE.MUTES] || {};
  const selected = gpSelectedGroups(d[GP.STORE.SELGROUPS]);
  const now = Date.now(), week = now - 7 * 86400000;
  const sixMonths = now - 183 * 86400000;  // selection list shows groups active in the last 6 months
  const windowStart = gpWindowStart(settings, now);
  const names = groupNames(store, chatlist);
  const monitored = monitoredSet(names, chatlist, mutes, plan, now, selected);
  const events = d[GP.STORE.EVENTS] || [];
  const rows = names.map((n) => {
    const ms = gpMuteState(mutes, n, now);
    const msgCount = ((store[n] || {}).messages || []).filter(m => (m.at || m.ts) >= windowStart).length;
    const lastTs = (chatlist[n] && chatlist[n].lastTs) || 0;
    return { name: n, selected: selected.has(n), muted: !!ms, mode: ms && ms.mode, until: ms && ms.until,
      monitored: monitored.has(n), msgCount, subCount: gpCommunitySubgroups(chatlist, n).length,
      isCommunity: !!(chatlist[n] && chatlist[n].isCommunity) || gpCommunitySubgroups(chatlist, n).length > 0,
      updatesWeek: events.filter(e => e.group === n && e.foundAt >= week).length, lastTs,
      inactive: lastTs < sixMonths && msgCount === 0 };
  }).sort((a, b) => (b.msgCount - a.msgCount) || (b.lastTs - a.lastTs)); // most active first
  return { ok: true, groups: rows, plan, maxGroups: plan.maxGroups === Infinity ? null : plan.maxGroups, selectedCount: selected.size };
}

/* Turn one group on/off, or set the whole selection at once (select all /
   none, onboarding picks). Free plan: at most GP_FREE_MAX_GROUPS selected. */
async function selectGroups(patch, replace) {
  return withLock(async () => {
    const d = await getAll([GP.STORE.SETTINGS, GP.STORE.INSTALL, GP.STORE.SELGROUPS, GP.STORE.CHATLIST]);
    const settings = Object.assign({}, SETTINGS_DEFAULTS, d[GP.STORE.SETTINGS] || {});
    const plan = gpPlan(settings, d[GP.STORE.INSTALL] || Date.now());
    let cur = replace ? {} : Object.assign({}, d[GP.STORE.SELGROUPS] || {});
    Object.keys(patch || {}).forEach((n) => { if (patch[n]) cur[n] = true; else delete cur[n]; });
    // ticking a Community container selects its subgroups instead (v0.5.10)
    const ex = gpExpandCommunities(cur, d[GP.STORE.CHATLIST] || {});
    cur = ex.sel;
    Object.keys(ex.expanded).forEach((c) => log('community "' + c + '" ticked - selected its ' + ex.expanded[c].length + ' subgroup(s) instead: ' + ex.expanded[c].join(', ')));
    const names = Object.keys(cur);
    if (plan.maxGroups !== Infinity && names.length > plan.maxGroups) {
      return { ok: false, error: 'The Free plan reads up to ' + plan.maxGroups + ' groups. Unselect one first, or go Pro for all of them.',
        count: Object.keys(d[GP.STORE.SELGROUPS] || {}).length };
    }
    await setAll({ [GP.STORE.SELGROUPS]: cur });
    log('group selection updated: ' + names.length + ' group(s) selected' + (names.length ? ' (' + names.slice(0, 5).join(', ') + (names.length > 5 ? ', ...' : '') + ')' : ''));
    return { ok: true, count: names.length };
  });
}

/* Delete EVERYTHING GroupPing stored (messages, items, settings, license,
   selection, logs). One click from Settings > Privacy. */
async function wipeAll() {
  await new Promise((res) => chrome.storage.local.clear(res));
  await setAll({ [GP.STORE.INSTALL]: Date.now(), [GP.STORE.PURGED]: '0.5.3' });
  gpLog('background', 'all GroupPing data deleted by the user');
  return { ok: true };
}

/* The group picker's own scan (v0.5.4): ask the WhatsApp tab to list every
   group - names only, no message content. Same attach dance as pullFromTabs:
   live content script, else reload the tab once, else give clear steps. */
async function listGroupsFromTab() {
  const tabs = await queryWhatsAppTabs();
  if (!tabs.length) return { ok: false, error: 'WhatsApp Web is not open in any tab. Open web.whatsapp.com first, then press Rescan.' };
  const msg = { type: 'gp-list-groups' };
  for (const tab of tabs) {
    if (!(await pingTab(tab.id))) continue;
    const r = await sendToTab(tab.id, msg);
    if (r && (r.ok || r.error)) return r;
  }
  log('group-list scan: no live content script in the WhatsApp tab - reloading it once to connect');
  const tab = tabs[0];
  await new Promise((res) => { try { chrome.tabs.reload(tab.id, {}, () => res()); } catch (e) { res(); } });
  if (await waitForContentScript(tab.id, 30000)) {
    log('group-list scan: content script connected after reloading the WhatsApp tab');
    const r = await sendToTab(tab.id, msg);
    if (r && (r.ok || r.error)) return r;
  }
  return { ok: false, error: 'Could not connect to the WhatsApp tab. Click the WhatsApp tab, press F5, then press Rescan again.' };
}

/* Settings > General > Run self-test: ask the WhatsApp tab what every
   selector sees (structure and counts only, no message text). */
async function selfTestFromTab() {
  const tabs = await queryWhatsAppTabs();
  if (!tabs.length) return { ok: false, error: 'WhatsApp Web is not open in any tab. Open it first.' };
  for (const tab of tabs) {
    if (!(await pingTab(tab.id))) continue;
    const r = await sendToTab(tab.id, { type: 'gp-selftest' });
    if (r && r.ok) return r;
    if (r && r.error) return { ok: false, error: r.error };
  }
  return { ok: false, error: 'GroupPing is not live in the WhatsApp tab yet. Click the WhatsApp tab, press F5 once, then run the self-test again.' };
}

/* ---------------- actions ---------------- */

async function itemAction(id, action, arg) {
  return withLock(async () => {
    const stored = (await getAll([GP.STORE.EVENTS]))[GP.STORE.EVENTS] || [];
    const ev = stored.find(e => e.id === id);
    if (!ev) return { ok: false, error: 'item not found' };
    if (action === 'resolve') { ev.state = 'resolved'; chrome.alarms.clear(REMIND_PREFIX + id); chrome.alarms.clear(SNOOZE_PREFIX + id); }
    else if (action === 'reopen') ev.state = 'open';
    else if (action === 'snooze') {
      let until;
      if (arg === 'tomorrow') { const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(9, 0, 0, 0); until = t.getTime(); }
      else until = Date.now() + Math.max(1, Number(arg) || 1) * 3600e3;
      ev.snoozeUntil = until;
      chrome.alarms.create(SNOOZE_PREFIX + id, { when: until });
    } else if (action === 'remind') { // calendar dialog: custom reminder lead
      ev.remindMinutes = Math.max(5, Number(arg) || 60); ev.reminded = false;
      const { settings } = await getSettings();
      scheduleReminder(ev, settings);
    }
    await setAll({ [GP.STORE.EVENTS]: stored });
    return { ok: true };
  });
}

async function setMute(name, mode) {
  return withLock(async () => {
    const mutes = (await getAll([GP.STORE.MUTES]))[GP.STORE.MUTES] || {};
    if (mode === 'forever') mutes[name] = { until: null, mode: 'all' };
    else if (mode === '30d') mutes[name] = { until: Date.now() + 30 * 86400000, mode: 'all' };
    else if (mode === 'mentions') mutes[name] = { until: null, mode: 'mentions' };
    else if (mode === 'unmute') delete mutes[name];
    await setAll({ [GP.STORE.MUTES]: mutes });
    return { ok: true };
  });
}

async function openChat(name) {
  const tabs = await queryWhatsAppTabs();
  if (!tabs.length) {
    chrome.tabs.create({ url: 'https://web.whatsapp.com/' });
    return { ok: false, opened: 'tab', error: 'WhatsApp Web was not open - opened it. Search for "' + name + '" once it loads.' };
  }
  const tab = tabs[0];
  try { chrome.tabs.update(tab.id, { active: true }); chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
  const r = await sendToTab(tab.id, { type: 'gp-open-chat', name });
  if (r && r.ok) return { ok: true };
  return { ok: false, error: 'Switched to WhatsApp Web, but could not find "' + name + '" in the visible chat list. Search for it there.' };
}

/* ---------------- messages from popup / options / content ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const t = msg && msg.type;
      if (t === 'gp-store') sendResponse({ ok: true, added: await storeBatch(msg.batches) });
      else if (t === 'gp-dashboard') sendResponse(await getDashboard());
      else if (t === 'gp-groups') sendResponse(await getGroupsList());
      else if (t === 'gp-scan-now') sendResponse(await fullScan('scan now'));
      else if (t === 'gp-list-groups') sendResponse(await listGroupsFromTab());
      else if (t === 'gp-catchup') sendResponse(await fullScan('catch-up button'));
      else if (t === 'gp-summary-now') sendResponse(await runEveningSummary());
      else if (t === 'gp-item') sendResponse(await itemAction(msg.id, msg.action, msg.arg));
      else if (t === 'gp-mute') sendResponse(await setMute(msg.name, msg.mode));
      else if (t === 'gp-open-chat') sendResponse(await openChat(msg.name));
      else if (t === 'gp-select-group') sendResponse(await selectGroups({ [msg.name]: msg.on !== false }, false));
      else if (t === 'gp-select-groups') sendResponse(await selectGroups(msg.patch || {}, msg.replace === true));
      else if (t === 'gp-finish-onboard') { await setAll({ [GP.STORE.ONBOARD]: true }); sendResponse({ ok: true }); }
      else if (t === 'gp-wipe') sendResponse(await wipeAll());
      else if (t === 'gp-connect') {
        const tabs = await queryWhatsAppTabs();
        if (!tabs.length) { chrome.tabs.create({ url: 'https://web.whatsapp.com/' }); sendResponse({ ok: true, opened: true }); }
        else { sendResponse({ ok: true, opened: false }); }
      } else if (t === 'gp-test-key') {
        const answer = await callGemini(msg.key, msg.model || GP.DEFAULT_MODEL, 'Reply with exactly: OK');
        sendResponse({ ok: true, answer: answer.slice(0, 50) });
      } else if (t === 'gp-reschedule-evening' || t === 'gp-reschedule') {
        await setupAlarms();
        const s = await getSettings();
        const ls = (await getAll([GP.STORE.LASTSCAN]))[GP.STORE.LASTSCAN];
        if (s.settings.geminiKey && !ls) scheduleKickoff('settings saved');
        sendResponse({ ok: true });
      }
      else if (t === 'gp-selftest') sendResponse(await selfTestFromTab());
      else if (t === 'gp-unreplied-now') sendResponse(await runUnrepliedCheck('popup'));
      else if (t === 'gp-unr-snooze') sendResponse(await unrAction('snooze', msg.name, msg.hours));
      else if (t === 'gp-unr-dismiss') sendResponse(await unrAction('dismiss', msg.name));
      else if (t === 'gp-unr-undismiss') sendResponse(await unrAction('clear', msg.name));
      else sendResponse({ ok: false, error: 'unknown message' });
    } catch (e) { sendResponse({ ok: false, error: e.message }); }
  })();
  return true;
});

/* Node test hook (never reached inside Chrome's worker). */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { monitoredSet, buildActionPlan, buildScanPrompt, selectUnscanned, mergeItems, parseJsonFrom,
    itemId, compactTime, SETTINGS_DEFAULTS, groupNames };
}
