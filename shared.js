/* GroupPing shared helpers: license validation + debug log + chat-list time parsing
   + the "waiting on your reply" ranking logic.
   Loaded by background.js (importScripts) and by popup/options pages (<script src>). */
'use strict';

const GP = {
  STORE: {
    SETTINGS: 'gp_settings',
    MSGS: 'gp_msgStore',
    EVENTS: 'gp_events',
    SUMMARIES: 'gp_summaries',
    LOG: 'gp_debugLog',
    INSTALL: 'gp_installTs',
    LASTSCAN: 'gp_lastScanTs',
    STATUS: 'gp_status',         // last scan outcome: {at, reason, ok, note, found, calls, readOk, chats, groups, opened, scanning}
    CHATLIST: 'gp_chatlist',      // chat-list rows harvested from the left sidebar
    UNR: 'gp_unrepliedState',     // snoozes, dismissals, last notification info
    UNRLIST: 'gp_unrepliedList',  // latest computed "waiting on you" list (popup reads this)
    PURGED: 'gp_purgedExcluded',  // version marker: excluded-chat data already cleaned up
    CURSOR: 'gp_cursor',          // per-chat timestamp of the last message already sent to Gemini
    MUTES: 'gp_mutes',            // {chatName: {until: ts|null, mode: 'all'|'mentions'}}
    PROGRESS: 'gp_progress',      // live progress of the group scan (popup polls this)
    ONBOARD: 'gp_onboarded',      // onboarding finished
    DAYSTATS: 'gp_dayStats',      // {day, scannedGroups:{name:true}} for the dashboard counts
    SELGROUPS: 'gp_selectedGroups', // {groupName: true} - opt-in: ONLY these groups may be read
    DIGESTS: 'gp_digests',        // {groupName: {at, discussed, plan, decision}} latest per-group digest
    DUPPURGED: 'gp_dupPurged',    // version marker: duplicate-attribution cleanup done
    LISTSTAMP: 'gp_groupListStamp' // when the FULL group list was last built (scans reuse it for a day)
  },
  TRIAL_DAYS: 14,
  DEFAULT_MODEL: 'gemini-3.8-flash',
  FALLBACK_MODEL: 'gemini-3.5-flash-lite', // used automatically when the main model is busy (HTTP 503/429)
  MAX_UNREPLIED_ITEMS: 50,       // hard cap on the stored "waiting on you" list
  // Chats GroupPing must ignore completely - no message capture, no plans, no
  // reply reminders. Match is on a lowercase substring of the chat name, or on
  // the phone number (digits only) when the chat shows a number instead of a name.
  EXCLUDED_CHAT_TERMS: ['instinct'],
  EXCLUDED_CHAT_DIGITS: ['16508702892'],
  DEFAULT_SUMMARY_TIME: '20:00',
  SCAN_MINUTES: 60,            // default scan interval (setting: 60 or 180)
  MAX_DEEP_READ: 30,           // most chats opened in one scan
  MSG_KEEP_PER_CHAT: 200, MSG_KEEP_DAYS: 4, MAX_CHATS_STORED: 80,
  DEFAULT_WINDOW_DAYS: 30,   // how far back GroupPing looks: chat list, messages, reminders, stored data
  DEFAULT_UNREPLIED_DAYS: 3,   // remind when the last message in a chat is not yours and is this old
  DEFAULT_NUDGE_HOURS: 6,      // gentle repeat nudge for items still unaddressed
  MAX_NUDGES_PER_DAY: 3,       // hard cap so repeat nudges never become noisy
  UNR_CHECK_MINUTES: 60        // how often the background re-checks the chat list
};

/* ---- License keys (offline check, no server needed) ----
   Format shown to users: GP-XXXX-XXXX-XXXX-XXX  (15 chars: 12 body + 3 check)
   Alphabet avoids confusing chars (no I, L, O, 0, 1).
   The 3 check chars come from a hash of a secret salt + the 12 body chars.
   Keep the salt private: anyone with it can mint keys. */
const GP_LICENSE = (function () {
  const SALT = 'groupping-v1-supriya-mastersunion';
  const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function checksumFor(body) {
    let h = fnv1a(SALT + body) % (ALPHA.length * ALPHA.length * ALPHA.length);
    let out = '';
    for (let i = 0; i < 3; i++) {
      out = ALPHA[h % ALPHA.length] + out;
      h = Math.floor(h / ALPHA.length);
    }
    return out;
  }

  function normalize(key) {
    let k = (key || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (k.startsWith('GP')) k = k.slice(2); // strip the display prefix
    return k;
  }

  function isValid(key) {
    const k = normalize(key);
    if (k.length !== 15) return false;
    for (const ch of k) if (!ALPHA.includes(ch)) return false;
    const body = k.slice(0, 12);
    return checksumFor(body) === k.slice(12);
  }

  function generate() {
    let body = '';
    for (let i = 0; i < 12; i++) body += ALPHA[Math.floor(Math.random() * ALPHA.length)];
    const full = body + checksumFor(body);
    return 'GP-' + full.match(/.{1,4}/g).join('-');
  }

  return { isValid, generate };
})();

/* ---- Debug log (visible in popup so a screenshot can be sent for help) ---- */
/* v0.5.7: the old logger did an unserialized get->push->set per line, so two
   lines written in the same instant raced and one was silently LOST - her
   v0.5.6 log was missing whole scan phases, which hid the real bugs. Lines
   now queue in memory and flush one write at a time, in order. */
var gpLogPending = [];
var gpLogWriting = false;
function gpLog(area, msg) {
  const line = new Date().toLocaleString() + ' [' + area + '] ' + msg;
  try { console.log('[GroupPing]', line); } catch (e) {}
  try {
    gpLogPending.push(line);
    if (gpLogWriting) return;
    gpLogWriting = true;
    const step = () => {
      if (!gpLogPending.length) { gpLogWriting = false; return; }
      const lines = gpLogPending.splice(0, gpLogPending.length);
      chrome.storage.local.get(GP.STORE.LOG, (d) => {
        const arr = Array.isArray(d[GP.STORE.LOG]) ? d[GP.STORE.LOG] : [];
        lines.forEach(l => arr.push(l));
        while (arr.length > 400) arr.shift();
        chrome.storage.local.set({ [GP.STORE.LOG]: arr }, step);
      });
    };
    step();
  } catch (e) { /* storage not ready yet */ }
}

/* ---- Trial / license status ---- */
function gpLicenseStatus(settings, installTs) {
  if (settings && settings.licenseKey && GP_LICENSE.isValid(settings.licenseKey)) {
    return { active: true, mode: 'licensed', label: 'Pro (licensed)' };
  }
  const days = installTs ? (Date.now() - installTs) / 86400000 : 0;
  if (days <= GP.TRIAL_DAYS) {
    const left = Math.max(1, Math.ceil(GP.TRIAL_DAYS - days));
    return { active: true, mode: 'trial', label: 'Free trial (' + left + ' day' + (left === 1 ? '' : 's') + ' left)' };
  }
  return { active: false, mode: 'expired', label: 'Trial expired - enter a license key' };
}

/* ---- Chat-list time parsing ----
   The WhatsApp Web chat list shows only a SHORT timestamp per chat, like
   "11:32" or "9:05 PM" (today), "Yesterday", "Thursday" (this week), or
   "14/10/2026" (older). We turn that into an approximate timestamp.
   Day-level entries get noon, so "3 days" can be off by some hours - good
   enough for a "you have not replied in days" reminder. */
function gpParseChatTime(tsText, now) {
  if (!tsText) return null;
  now = now || Date.now();
  const t = tsText.trim();
  const d = new Date(now);

  let m = t.match(/^(\d{1,2}):(\d{2})(?:\s?([AP])\.?M\.?)?$/i);
  if (m) {
    let h = parseInt(m[1], 10);
    if (m[3]) {
      const pm = m[3].toUpperCase() === 'P';
      if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
    }
    const r = new Date(d);
    r.setHours(h, parseInt(m[2], 10), 0, 0);
    if (r.getTime() > now + 5 * 60000) r.setDate(r.getDate() - 1); // time in the future = yesterday
    return r.getTime();
  }

  if (/^yesterday$/i.test(t)) {
    const r = new Date(d); r.setDate(r.getDate() - 1); r.setHours(12, 0, 0, 0);
    return r.getTime();
  }

  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const di = days.indexOf(t.toLowerCase());
  if (di !== -1) {
    const r = new Date(d); r.setHours(12, 0, 0, 0);
    let back = (r.getDay() - di + 7) % 7; if (back === 0) back = 7;
    r.setDate(r.getDate() - back);
    return r.getTime();
  }

  m = t.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    let y = parseInt(m[3], 10); if (y < 100) y += 2000;
    // WhatsApp Web in India shows day/month/year. If that lands in the future, try month/day.
    let r = new Date(y, b - 1, a, 12, 0, 0);
    if (r.getTime() > now + 86400000) r = new Date(y, a - 1, b, 12, 0, 0);
    return r.getTime();
  }

  return null; // unrecognised - caller treats the chat as "age unknown"
}

/* ---- Look-back window ----
   The single age limit for everything GroupPing does (setting, default 30
   days): chats older than this are never opened or read, their messages never
   go to Gemini, they never appear in reply reminders, and stored data older
   than this is deleted. Returns the oldest timestamp still inside the window. */
function gpWindowStart(settings, now) {
  const days = Math.min(365, Math.max(1, parseInt(settings && settings.windowDays, 10) || GP.DEFAULT_WINDOW_DAYS));
  return (now || Date.now()) - days * 86400000;
}

/* ---- Name-list matching (important people / never-remind lists) ----
   The user types one name per line (or comma-separated). A chat matches when
   its name contains any listed name, case-insensitive. */
function gpNameMatches(listStr, chatName) {
  if (!listStr || !chatName) return false;
  const n = chatName.toLowerCase();
  return listStr.split(/[\n,]/).map(s => s.trim().toLowerCase()).filter(Boolean)
    .some(item => n.includes(item));
}

/* ---- Excluded chats (never scanned, planned from or reminded about) ---- */
function gpIsExcludedChat(name) {
  if (!name) return false;
  const lower = String(name).toLowerCase();
  if (GP.EXCLUDED_CHAT_TERMS.some(t => lower.includes(t))) return true;
  const digits = lower.replace(/\D/g, '');
  return digits.length > 5 && GP.EXCLUDED_CHAT_DIGITS.some(d => digits.includes(d));
}

/* ---- Unsaved-number and bulk-sender detection (reply-reminder noise filter) ---- */
// A chat name that is only a phone number means the sender is not in your contacts.
function gpLooksLikePhoneNumber(name) {
  if (!name) return false;
  const s = String(name).trim();
  return /^[+]?[-().\s\d]{6,}$/.test(s) && (s.replace(/\D/g, '').length >= 6);
}

// Bulk / promotional phrasing typical of business broadcasts. Only applied to
// chats you have never written in, so real conversations mentioning these
// words are not affected.
const GP_PROMO_PATTERN = /\b(dear (customer|user|sir|madam)|valued customer|exclusive offer|special offer|limited (time|period|seats)|\d{1,2}\s?%\s?off|flat \d|discount|cash\s?back|cashback|webinar|masterclass|register (now|today|free)|book (your )?(free )?seat|kyc|e-?kyc|pre-?approved|personal loan|home loan|credit card|\bemi\b|congratulations?|you have (won|been selected)|winner|prize|lottery|lucky draw|unsubscribe|opt[ -]?out|stop to (unsubscribe|opt)|apply now|claim (now|your)|free (trial|gift)|investment (plan|opportunit)|trading (tips|calls)|guaranteed returns?|policy (is )?(due|expir)|premium (is )?due|recharge (now|offer)|plan (has )?expired|validity expir)/i;
function gpIsPromoText(text) {
  return !!text && GP_PROMO_PATTERN.test(text);
}

/* Previews that are not reply-worthy no matter what: broken/undelivered
   placeholders and payment requests (someone asking you to pay is not a
   conversation waiting on your reply). */
const GP_BROKEN_PREVIEW = /this message couldn'?t load|waiting for this message|this message (is|was) (not available|deleted)|message not available/i;
const GP_PAYMENT_PREVIEW = /(upi:\/\/|rzp\.io|paypal\.me|pay\.google|paytm|phonepe|\bgpay\b|google pay|payment (link|request)|pay (using|via|through) (this )?link|requested .* (payment|money))/i;
function gpIsBrokenPreview(text) { return !!text && GP_BROKEN_PREVIEW.test(text); }
function gpIsPaymentPreview(text) { return !!text && GP_PAYMENT_PREVIEW.test(text); }

/* Sender names that are broadcasts, not people: job boards, deal/promo
   channels, official announcement streams. Only applied to chats you have
   never written in (same gate as the promo-text filter). */
const GP_PROMO_NAME = /(job|vacanc|hiring|career|recruit|placement|internship|deal|loot|offer|discount|\bsale\b|\bstore\b|\bshop\b|\bmart\b|official|broadcast|promo|newsletter)/i;
function gpIsPromoSender(name) { return !!name && GP_PROMO_NAME.test(name); }

/* ---- "Waiting on your reply" logic ----
   A chat is a candidate when the LAST message in it is not yours (the preview
   does not start with "You:") and that message is at least `thresholdDays` old.
   The chat list can only tell us about the last message, so that is the rule.
   Candidates are scored so the popup and notifications can show a short,
   ranked top list instead of one alert per chat. */
function gpComputeUnreplied(chatlist, settings, unr, now) {
  now = now || Date.now();
  const thresholdDays = Math.max(1, parseInt(settings.unrepliedDays, 10) || GP.DEFAULT_UNREPLIED_DAYS);
  const thresholdMs = thresholdDays * 86400000;
  const snooze = (unr && unr.snooze) || {};
  const dismiss = (unr && unr.dismiss) || {};
  const out = [];

  const stats = { kept: 0, skippedExcluded: 0, skippedUnsavedNumber: 0, skippedPromo: 0, skippedSilentGroup: 0, skippedOld: 0, skippedBroken: 0, skippedPayment: 0 };

  Object.keys(chatlist || {}).forEach((name) => {
    const e = chatlist[name];
    if (!e || !e.lastTs) return;          // no usable timestamp -> cannot judge, skip
    if (e.isGroup !== true) return;       // PRIVACY: reply reminders are for groups only, never direct chats
    if (e.isYou) return;                  // last message is yours -> nothing waiting
    const age = now - e.lastTs;
    if (age < thresholdMs) return;        // replied-to-recently or fresh chat
    if (e.lastTs < gpWindowStart(settings, now)) { stats.skippedOld++; return; } // older than the look-back window
    if (gpIsBrokenPreview(e.preview)) { stats.skippedBroken++; return; }    // placeholder text, nothing to answer
    if (gpNameMatches(settings.unrepliedMuteNames, name)) return; // user said never remind
    if (snooze[name] && snooze[name] > now) return;                // snoozed
    if (dismiss[name] && e.lastTs <= dismiss[name]) return;        // dismissed until a NEWER message arrives

    const important = gpNameMatches(settings.importantNames, name);

    /* Noise filters, so the list is people and groups that matter, not
       broadcasts. Chats on your Important list always stay. */
    if (!important) {
      if (gpIsExcludedChat(name)) { stats.skippedExcluded++; return; }       // excluded chats (e.g. Instinct)
      if (gpIsPaymentPreview(e.preview)) { stats.skippedPayment++; return; } // a payment request is not a reply you owe
      if (!e.isGroup && gpLooksLikePhoneNumber(name)) { stats.skippedUnsavedNumber++; return; } // unsaved numbers
      if (e.everSent !== true && gpIsPromoText(e.preview || '')) { stats.skippedPromo++; return; } // bulk/promotional senders
      if (e.everSent !== true && gpIsPromoSender(name)) { stats.skippedPromo++; return; }         // job boards / promo channels
      if (e.isGroup && e.everSent !== true) { stats.skippedSilentGroup++; return; } // groups you have never written in
    }

    stats.kept++;
    const days = Math.floor(age / 86400000);
    const question = /\?\s*$/.test(e.preview || '') ||
      /\b(please|can you|could you|reply|kab|kya|when are|did you)\b/i.test(e.preview || '');

    let score = 0;
    if (important) score += 100;                 // user-pinned people/groups always on top
    if (e.mention) score += 40;                  // someone @-mentioned you in a group
    if (!e.isGroup) score += 20;                 // a person messaging you directly
    if (e.unread > 0) score += 15 + Math.min(e.unread, 10); // unread messages you have not opened
    if (question) score += 10;                   // last message looks like a question
    score += Math.min(days, 14) * 2;             // the longer it waits, the higher it ranks
    if (e.muted) score -= 30;                    // chats you muted in WhatsApp rank low

    out.push({
      name, days, lastTs: e.lastTs, score,
      unread: e.unread || 0, mention: !!e.mention, isGroup: !!e.isGroup,
      muted: !!e.muted, important, question,
      preview: (e.preview || '').slice(0, 80)
    });
  });

  out.sort((a, b) => b.score - a.score);
  const capped = out.slice(0, GP.MAX_UNREPLIED_ITEMS);
  capped.stats = stats;
  return capped;
}


/* ================= v0.5 helpers ================= */

function gpStartOfDay(ts) { const d = new Date(ts || Date.now()); d.setHours(0, 0, 0, 0); return d.getTime(); }
function gpDayKey(ts) {
  const d = new Date(ts || Date.now());
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* Mute state for one chat. Returns null (not muted) or {mode, until}.
   mode 'all' = no updates; 'mentions' = pause but still allow @mentions. */
function gpMuteState(mutes, name, now) {
  const m = mutes && mutes[name];
  if (!m) return null;
  if (m.until && m.until <= (now || Date.now())) return null; // expired
  return { mode: m.mode || 'all', until: m.until || null };
}

/* Priority label for a "needs your reply" row. */
function gpPriority(i) {
  // High is deliberately rare: your pinned people, an @mention, or an extreme score.
  if (i.important || i.mention || i.score >= 90) return 'High';
  if (i.score >= 45) return 'Medium';
  return 'Low';
}

function gpAgeText(ts, now) {
  const mins = Math.max(0, Math.round(((now || Date.now()) - ts) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const h = Math.round(mins / 60);
  if (h < 24) return h + ' hr ago';
  const d = Math.round(h / 24);
  return d + ' day' + (d === 1 ? '' : 's') + ' ago';
}

/* "YYYY-MM-DD" + "HH:MM" -> epoch ms in local time, or null. */
function gpWhenTs(date, time) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const t = /^\d{1,2}:\d{2}$/.test(time || '') ? time : '09:00';
  const ts = new Date(date + 'T' + (t.length === 4 ? '0' + t : t) + ':00').getTime();
  return isNaN(ts) ? null : ts;
}

/* Google Calendar "template" link: opens a pre-filled event form in the user's
   own Google Calendar. No sign-in or API needed; the user presses Save there. */
function gpCalendarUrl(o) {
  const start = gpWhenTs(o.date, o.time) || (Date.now() + 3600e3);
  let end = o.endTime && gpWhenTs(o.date, o.endTime);
  if (!end || end <= start) end = start + 3600e3;
  const f = (ts) => {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + 'T' + p(d.getHours()) + p(d.getMinutes()) + '00';
  };
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
  const q = new URLSearchParams();
  q.set('action', 'TEMPLATE');
  q.set('text', o.title || 'Event');
  q.set('dates', f(start) + '/' + f(end));
  if (tz) q.set('ctz', tz);
  if (o.location) q.set('location', o.location);
  if (o.details) q.set('details', o.details);
  return 'https://calendar.google.com/calendar/render?' + q.toString();
}

/* Which dashboard tab an open item belongs to, given "now". */
function gpItemBucket(ev, now) {
  now = now || Date.now();
  const today = gpDayKey(now);
  const tomorrow = gpDayKey(now + 86400000);
  if (ev.kind === 'deadline' && ev.date && ev.date <= tomorrow) return 'today'; // near deadlines stay in focus
  if (ev.date && ev.date > today) return 'upcoming';
  return 'today';
}

/* ---- Plans: trial = everything, Pro = everything, Free (after trial) = limited ---- */
const GP_FREE_MAX_GROUPS = 3;
function gpPlan(settings, installTs) {
  if (settings && settings.licenseKey && GP_LICENSE.isValid(settings.licenseKey)) {
    return { tier: 'pro', label: 'Pro', maxGroups: Infinity, calendar: true, unreplied: true, daysLeft: null };
  }
  const days = installTs ? (Date.now() - installTs) / 86400000 : 0;
  if (days <= GP.TRIAL_DAYS) {
    const left = Math.max(1, Math.ceil(GP.TRIAL_DAYS - days));
    return { tier: 'trial', label: 'Free trial - ' + left + ' day' + (left === 1 ? '' : 's') + ' left',
      maxGroups: Infinity, calendar: true, unreplied: true, daysLeft: left };
  }
  return { tier: 'free', label: 'Free plan', maxGroups: GP_FREE_MAX_GROUPS, calendar: false, unreplied: false, daysLeft: 0 };
}

/* Best-effort parse of WhatsApp's per-message stamp ("10:32, 16/10/2026" or
   "10:32 am, 10/16/2026") into epoch ms. Returns null if unreadable. */
function gpParseMsgTime(tt) {
  if (!tt) return null;
  const tm = String(tt).match(/(\d{1,2}):(\d{2})\s?([ap])?\.?m?\.?/i);
  const dm = String(tt).match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})/);
  if (!tm || !dm) return null;
  let h = parseInt(tm[1], 10);
  if (tm[3]) { const pm = tm[3].toLowerCase() === 'p'; if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  let a = parseInt(dm[1], 10), b = parseInt(dm[2], 10), y = parseInt(dm[3], 10);
  if (y < 100) y += 2000;
  let day = a, mon = b;
  if (mon > 12) { day = b; mon = a; }
  const ts = new Date(y, mon - 1, day, h, parseInt(tm[2], 10)).getTime();
  return isNaN(ts) ? null : ts;
}

/* Cheap local pre-filter: does a message even hint at a plan, time, deadline or request?
   Chats whose new messages have none of these cost zero Gemini tokens. */
const GP_SIGNAL = /(\?|\b(today|tonight|tomorrow|tmrw|tmr|morning|evening|afternoon|noon|midnight|mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|deadline|due|submit|submission|last date|meeting|call|class|exam|test|quiz|party|dinner|lunch|breakfast|match|game|play|trip|reach|venue|rsvp|confirm|urgent|asap|please|pls|plz|can you|could you|kab|kal|aaj|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b|\d{1,2}(:\d{2})?\s?(am|pm)\b|\d{1,2}:\d{2}|\d{1,2}[\/-]\d{1,2}\b)/i;
function gpHasSignal(text) { return GP_SIGNAL.test(text || ''); }

/* ================= v0.5.3 privacy ================= */

/* ---- Sensitive-content guard ----
   Runs on EVERY message before it is stored (and therefore before Gemini can
   ever see it), and on chat-list previews. Two levels:
   - DROP the whole message when it looks like an OTP, a bank/card alert or
     credentials. It is never stored, never analysed, never sent anywhere.
   - REDACT inside kept messages: codes, card/account/Aadhaar/PAN numbers,
     phone numbers, emails, payment links and token-carrying URLs become
     placeholders like <code>.
   Best-effort pattern matching, not a guarantee - the Settings > Privacy page
   says so plainly and offers "local only" mode and full data deletion. */
const GP_DROP_PATTERN = new RegExp([
  '\\botp\\b', 'one[- ]?time (password|passcode|code|pin)',
  'verification code', 'authentication code', 'security code', 'login (code|pin|otp)',
  'do not share (this|the|your|it)',
  'use \\d{4,8} (as|to) (your )?(otp|code|pin|password)',
  '\\b(debited|credited)\\b.{0,80}\\b(a/?c|account|acct|card)\\b',
  '\\b(a/?c|account|acct)\\b.{0,80}\\b(debited|credited)\\b',
  '\\b(avl|available) bal(ance)?\\b',
  '\\b(cvv|cvc)\\b', '\\bcard (number|no\\.?|details)\\b', '\\bexp(iry)? date\\b', '\\batm pin\\b',
  '\\bmpin\\b', '\\bupi pin\\b', '\\bnet ?banking (password|pin)\\b', '\\binternet banking\\b',
  '\\b(password|passcode)\\b\\s*(is|:)', '\\b(your|the|atm|card) pin (is|:)',
  '\\bifsc\\b', '\\bswift code\\b',
  '\\b(kyc|e-?kyc) (update|expired|pending|verification|rejected)\\b'
].join('|'), 'i');

function gpLooksSensitive(text) {
  if (!text) return false;
  const t = String(text);
  if (GP_DROP_PATTERN.test(t)) return true;
  // "XXXXXX is your OTP/code" phrasing without the words above
  if (/\b\d{4,8}\s+(is|as)\s+(your|the)\s+(otp|code|pin|password)\b/i.test(t)) return true;
  return false;
}

/* In-place redaction rules, applied in order. Longest/most-specific first so a
   card number is not half-eaten by the phone rule. */
const GP_REDACT_RULES = [
  // UPI handles and payment links
  { re: /upi:\/\/\S+/gi, to: '<payment link>' },
  { re: /\b(?:rzp\.io|paypal\.me|paytm\.me|pay\.google\.com|phon\.pe|phonepe|bhim|gpay)\S*/gi, to: '<payment link>' },
  { re: /\b[\w.+-]+@(?:ok|ybl|axl|paytm|upi|ibl|sbi|hdfc|icici|axis|kotak)[\w]*/gi, to: '<upi id>' },
  // URLs carrying tokens or credentials in the query string
  { re: /\bhttps?:\/\/[^\s?]+\?[^\s]*(?:token|sig|signature|auth|api[-_]?key|pwd|password|passcode|session|jwt|access[-_]?key|secret)[^\s]*/gi, to: '<link>' },
  // emails
  { re: /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, to: '<email>' },
  // PAN (India): 5 letters, 4 digits, 1 letter
  { re: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, to: '<id number>' },
  // payment card numbers: 13-19 digits, optionally grouped by spaces/dashes
  { re: /\b(?:\d[ -]?){13,19}\b/g, to: '<card number>' },
  // Aadhaar: 12 digits, often grouped 4-4-4 (after the card rule)
  { re: /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, to: '<id number>' }
];
const GP_PHONE_CANDIDATE = /\+?\d[\d\s().-]{8,16}\d/g;
const GP_CODE_6 = /\b\d{6}\b/g;
const GP_CODE_KEYWORDED = /\b(?:otp|code|pin|password|passcode|verification|is)\s*[:#-]?\s*(\d{4,8})\b/gi;

function gpRedactText(text) {
  if (text == null) return { text, dropped: false, redacted: false };
  let t = String(text);
  if (gpLooksSensitive(t)) return { text: '', dropped: true, redacted: false };
  let changed = false;
  GP_REDACT_RULES.forEach((r) => {
    t = t.replace(r.re, () => { changed = true; return r.to; });
  });
  // phone numbers: any run that boils down to 10-15 digits
  t = t.replace(GP_PHONE_CANDIDATE, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) { changed = true; return '<phone number>'; }
    return m;
  });
  // 6-digit standalone codes (OTPs are usually 6 digits)
  t = t.replace(GP_CODE_6, () => { changed = true; return '<code>'; });
  // 4-8 digit codes only when introduced by a keyword ("code: 4821")
  t = t.replace(GP_CODE_KEYWORDED, (m) => { changed = true; return m.replace(/\d{4,8}/, '<code>'); });
  return { text: t, dropped: false, redacted: changed };
}

/* ---- Opt-in group selection (v0.5.3) ----
   Nothing is read until the user turns a group on. Group NAMES may be listed
   from the chat list so she can choose; message content of unselected groups
   is never opened, stored or sent. */
function gpSelectedGroups(raw) {
  const out = new Set();
  if (raw && typeof raw === 'object') Object.keys(raw).forEach((n) => { if (raw[n] === true) out.add(n); });
  return out;
}

/* v0.5.10: Community containers. A community's subgroups are ordinary chat-list
   rows whose row carries the community name as a label (stored as aliases).
   So the subgroups of community C are the stored groups listing C as an alias. */
function gpNormName(v) {
  return String(v == null ? '' : v).normalize('NFKC').replace(/[\p{Extended_Pictographic}\u00A0\u200B-\u200D\uFE0F]/gu, ' ')
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().toLowerCase();
}
function gpCommunitySubgroups(chatlist, name) {
  const want = gpNormName(name), out = [];
  if (!want) return out;
  Object.keys(chatlist || {}).forEach((n) => {
    const e = chatlist[n];
    if (!e || e.isGroup !== true || n === name) return;
    if ((e.aliases || []).some(a => gpNormName(a) === want)) out.push(n);
  });
  return out;
}
/* Replace every selected community by its subgroups. Returns {sel, expanded:{community:[subs]}}. */
function gpExpandCommunities(sel, chatlist) {
  const out = Object.assign({}, sel), expanded = {};
  Object.keys(sel || {}).forEach((n) => {
    if (sel[n] !== true) return;
    const subs = gpCommunitySubgroups(chatlist, n);
    if (!subs.length) return;
    subs.forEach((s) => { out[s] = true; });
    delete out[n];
    expanded[n] = subs;
  });
  return { sel: out, expanded };
}

/* Node test hook: the extension pages load this file as a classic script, so
   exporting only happens under a CommonJS loader (the test suite). */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GP, GP_LICENSE, gpLog, gpLicenseStatus, gpParseChatTime, gpWindowStart, gpNameMatches,
    gpIsExcludedChat, gpLooksLikePhoneNumber, gpIsPromoText, gpIsBrokenPreview, gpIsPaymentPreview, gpIsPromoSender,
    gpComputeUnreplied, gpStartOfDay, gpDayKey, gpMuteState, gpPriority, gpAgeText, gpWhenTs, gpCalendarUrl,
    gpItemBucket, gpPlan, gpParseMsgTime, gpHasSignal, GP_SIGNAL, GP_PROMO_PATTERN, GP_BROKEN_PREVIEW,
    GP_PAYMENT_PREVIEW, GP_PROMO_NAME, GP_FREE_MAX_GROUPS, gpLooksSensitive, gpRedactText, gpSelectedGroups,
    GP_DROP_PATTERN, GP_REDACT_RULES };
}
