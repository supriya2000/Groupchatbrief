/* GroupPing content script - runs on web.whatsapp.com only.
   Reads messages from the chat you currently have open, plus structured rows
   from the chat list on the left (name, last-message preview, timestamp,
   unread count, @mention badge). Everything stays in local browser storage;
   nothing is sent anywhere by this file. (Gemini is called only from the
   extension's background worker, with your own API key.)

   HONEST LIMITS:
   - WhatsApp Web only renders the chat you have open, so full message capture
     works for the open chat. Other chats contribute their chat-list row only.
   - It only looks at the last N days (Settings > General, default 30): older
     chats are never opened, read, sent to Gemini or kept.
   - The chat list is VIRTUALISED: only the chats currently scrolled into view
     exist on the page. GroupPing knows about the chats it has seen on screen.
     Use the popup's "Scan my full chat list" button to scroll through and load
     all of them (about 200 chats takes ~30 seconds).
   - AFTER INSTALLING OR RELOADING THE EXTENSION you must reload the WhatsApp
     Web tab once (click it and press F5), otherwise this script is not in the
     page and nothing can be collected.
   - WhatsApp changes its page layout often. Every reader below tries several
     selector strategies and writes what it found to the popup's Debug log
     (counts per strategy), so a breakage shows exactly which part stopped
     matching. */
(function () {
  'use strict';

  let GP_V = '?';
  try { GP_V = chrome.runtime.getManifest().version; } catch (e) {}
  if (window.__gpContentV === GP_V) return; // same version already injected (e.g. programmatic re-inject)
  window.__gpContentV = GP_V;

  function log(msg) { gpLog('content', msg); }

  /* v0.5.8: per-scan identity books. A group's real identity is the @g.us id
     inside its messages' data-ids. If a second NAME turns up with an id (or
     message ids) already read under another name, the pane did not change and
     the read is rejected - never stored twice under two names. */
  const scanJidOwner = new Map();   // group jid -> group name
  const scanIdOwner = new Map();    // message id -> group name
  let lastReadCount = 0;
  const communityNames = new Set();   // v0.5.10: selected names that turned out to be Community containers
  const ANNOUNCE = /^announcements?$/i;

  // First thing: say we are here, so the Debug log always shows the script injected.
  log('content script v' + GP_V + ' injected on ' + location.href);

  function qsa(root, sel) {
    try { return Array.from((root || document).querySelectorAll(sel)); } catch (e) { return []; }
  }

  /* ---------- open-chat extraction ---------- */

  /* The chat header shows the group/contact name. Only the header TITLE is a
     chat name - the line under it is a subtitle ("click here for group info",
     "online", "last seen ...", a member list) and must never be used. */
  const BAD_HEADER_NAME = /^(click here for (group|community|channel) info|online$|typing\.\.\.$|last seen|voice call|video call)/i;
  /* v0.5.6: more things that live in the header but are NOT the chat name:
     - icon labels ("ic-group-filled") from the avatar's data-icon span
     - the member-list subtitle ("A, B, C ... 180 more") of a group
     Invisible bidi/zero-width marks are stripped BEFORE matching, otherwise
     "click here for group info" with a hidden mark slips past the regex. */
  const ICON_LABEL = /^(ic[-_][a-z0-9-_]+|[a-z0-9-]+-(filled|outline|rtl))$/i;
  const MEMBER_LIST = /^([^,]{1,30},\s*){2,}/;
  const MORE_SUFFIX = /(\.\.\.|\u2026)?\s*\+?\s*\d+\s*more$/i;

  function cleanHeaderText(v) {
    return String(v == null ? '' : v)
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u00A0\u200B-\u200D\uFE0F]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  /* Why is this text unusable as a chat name? null = it is usable. */
  function badHeaderText(v) {
    if (!v) return 'empty';
    if (BAD_HEADER_NAME.test(v)) return 'subtitle hint';
    if (ICON_LABEL.test(v)) return 'icon label';
    if (MORE_SUFFIX.test(v)) return 'member list';
    if (MEMBER_LIST.test(v) && v.length > 40) return 'member list';
    return null;
  }

  /* The chat header shows the group/contact name. Only the header TITLE is a
     chat name - the line under it is a subtitle ("click here for group info",
     "online", a member list) and must never be used. v0.5.6: collect every
     candidate with its font size and screen position, reject subtitles /
     icons / member lists, then take the LARGEST, topmost surviving text -
     the same trick the chat-list reader uses, because the title always
     renders bigger than the subtitle. */
  function getOpenChatName() {
    const header = document.querySelector('#main header');
    if (!header) return { name: null, diag: 'no #main header found (no chat open)' };
    const cands = [];
    const add = (v, how, el) => {
      v = cleanHeaderText(v);
      if (!v) return;
      let fs = 0, top = 0;
      if (el) {
        try { fs = parseFloat(getComputedStyle(el).fontSize) || 0; } catch (e) {}
        try { top = el.getBoundingClientRect().top; } catch (e) {}
      }
      cands.push({ v, how, fs, top, why: badHeaderText(v) });
    };
    qsa(header, 'span[title]').forEach((el) => add(el.getAttribute('title') || el.textContent, 'span[title]', el));
    const btn = header.querySelector('div[role="button"]') || header;
    qsa(btn, 'span[dir="auto"]').forEach((el) => add(el.textContent, 'header dir=auto span', el));
    add(header.getAttribute('aria-label'), 'header aria-label', null);
    const usable = cands.filter(c => !c.why);
    if (usable.length) {
      const maxFs = Math.max.apply(null, usable.map(c => c.fs));
      usable.sort((a, b) => ((b.fs >= maxFs - 0.5 ? 1 : 0) - (a.fs >= maxFs - 0.5 ? 1 : 0)) || (a.top - b.top));
      const best = usable[0];
      return { name: best.v, diag: 'chat name from ' + best.how };
    }
    /* v0.5.8: structural fallback. Some header layouts carry the title in a
       plain element (no title attribute, no dir=auto). Walk every element that
       owns text, drop subtitles/member lists/icons, take the largest topmost. */
    const walked = [];
    qsa(header, '*').forEach((el) => {
      let own = '';
      el.childNodes.forEach((n) => { if (n.nodeType === 3) own += n.textContent; });
      const v = cleanHeaderText(own);
      if (!v || v.length > 80 || badHeaderText(v)) return;
      let fs = 0, top = 0, w = 0;
      try { const cs = getComputedStyle(el); fs = parseFloat(cs.fontSize) || 0; const r = el.getBoundingClientRect(); top = r.top; w = r.width; } catch (e) {}
      if (w < 4) return;
      walked.push({ v, fs, top });
    });
    if (walked.length) {
      const mf = Math.max.apply(null, walked.map(c => c.fs));
      walked.sort((a, b) => ((b.fs >= mf - 0.5 ? 1 : 0) - (a.fs >= mf - 0.5 ? 1 : 0)) || (a.top - b.top));
      return { name: walked[0].v, diag: 'chat name from header text walk' };
    }
    const seen = cands.map(c => c.why + ' "' + c.v.slice(0, 40) + '"').join(', ');
    return { name: null, diag: 'header found but every candidate was empty, a subtitle or a member list (saw: ' + (seen || 'nothing') + ')' };
  }

  /* Compare chat names forgivingly: WhatsApp renders the same name with
     different invisible characters (nbsp, zero-width joiners, emoji variation
     selectors) and spacing in the chat list vs the header, so a strict ===
     misses matches that are really the same chat (v0.5.5). */
  function normChatName(v) {
    return String(v == null ? '' : v)
      .normalize('NFKC')
      .replace(/[\p{Extended_Pictographic}\u00A0\u200B-\u200D\uFE0F]/gu, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /* Is `name` the chat on screen right now? Answers from the header title,
     and the diagnostics always include what the header ACTUALLY shows, so the
     Debug log says why a match failed instead of just "header did not
     change". */
  /* Is `name` the chat on screen right now? Three proofs, in order:
     1. the header title matches (forgiving compare),
     2. the header title matches one of the chat's ALIASES - a group that
        sits under a community shows the community name in its header
        (v0.5.5 rejected exactly these chats),
     3. the header name cannot be read at all (subtitle/icon/mid-transition)
        BUT the open chat is provably a group - its messages carry data-id
        "@g.us". Safe because the search box only ever opens the exact-match
        row, and the store-time check re-verifies before a message is kept. */
  /* v0.5.7: two fixes that were burning every scan.
     (a) A header showing the COMMUNITY name (an alias) is NOT this chat - it
         means the community (or its Announcements group) got opened instead.
         v0.5.6 accepted it and would have stored the wrong group's messages.
         Now it is a wrongChat, and the opener tries the next result row.
     (b) The group proof (@g.us messages) used to pass on the PREVIOUS chat's
         messages while the pane was mid-swap - the "opened, verified" line in
         her log, after which 0 messages of the new chat were read. A proof
         now counts only when the message pane actually CHANGED since the
         click (ctx.beforeSig). ctx.prevName tells lag (old chat still
         rendering) apart from a genuinely wrong chat. */
  /* v0.5.8: identity helpers.
     paneJid(): the group id (xxxx@g.us) carried by the open chat's messages -
     unique per group, so it proves WHICH group is on screen and whether the
     pane really changed. activeRow(): the highlighted row of the chat list. */
  function paneJid() {
    const panel = findMainPanel();
    if (!panel) return null;
    const ids = qsa(panel, '[data-id]');
    for (const n of ids) {
      const m = String(n.getAttribute('data-id') || '').match(/([0-9]+(?:-[0-9]+)?@g\.us)/);
      if (m) return m[1];
    }
    return null;
  }
  function jidTag(j) { return j ? '..' + String(j).replace(/@g\.us$/, '').slice(-5) : 'none'; }
  function activeRow() {
    const pane = findChatListPane();
    if (!pane) return null;
    const el = pane.querySelector('[aria-selected="true"]');
    if (!el) return null;
    return el.closest('[role="listitem"],[role="row"],li') || el;
  }
  function activeRowNames() {
    const r = activeRow();
    return r ? rowNameCandidates(r).map(normChatName).filter(Boolean) : [];
  }

  /* Is `name` the chat on screen right now? Proof order:
     1. the header title equals the name (forgiving compare);
     2. the highlighted chat-list row carries the name AND the pane changed;
     3. (header unreadable) the pane shows a group id that differs from the
        chat before the click AND no other name has already been read with it.
     Never accepted: a pane that did not change since the click, a group id
     already read under another name, a header showing another chat.
     ctx.requirePositive (the "is it already open?" check) accepts only 1 or 2:
     no click happened, so there is nothing to compare a pane change against. */
  function chatIsOpen(name, aliases, ctx) {
    ctx = ctx || {};
    const want = normChatName(name);
    if (!want) return { open: false, diag: 'no name to compare' };
    const hdr = getOpenChatName();
    const jid = paneJid();
    const hasBefore = Object.prototype.hasOwnProperty.call(ctx, 'beforeJid');
    const act = activeRowNames();
    if (hdr.name) {
      const got = normChatName(hdr.name);
      if (got === want) return { open: true, jid, diag: 'header shows "' + hdr.name + '"' };
      if (ctx.prevName && got === normChatName(ctx.prevName)) {
        return { open: false, diag: 'the previous chat "' + hdr.name + '" is still on screen - the new one has not loaded yet' };
      }
      if ((aliases || []).some(a => normChatName(a) === got)) {
        return { open: false, wrongChat: hdr.name,
          diag: 'the open chat is "' + hdr.name + '" - that is the community "' + name + '" sits under, not the group itself' };
      }
      return { open: false, wrongChat: hdr.name, diag: 'expected "' + name + '" but the open chat is "' + hdr.name + '" (' + hdr.diag + ')' };
    }
    const changed = hasBefore ? (!!jid && jid !== ctx.beforeJid) : true;
    if (act.indexOf(want) !== -1 && (!hasBefore || changed)) {
      return { open: true, jid, proof: 'active-row', diag: 'header unreadable (' + hdr.diag + ') but the highlighted chat-list row is "' + name + '" and the pane changed' };
    }
    if (ctx.requirePositive) return { open: false, diag: 'not positively open (' + hdr.diag + '; highlighted row ' + (act.length ? 'is another chat' : 'not readable') + ')' };
    if (!jid) {
      return { open: false, diag: hdr.diag + '; no group message ids on screen yet' };
    }
    if (hasBefore && jid === ctx.beforeJid) {
      return { open: false, diag: hdr.diag + '; the message pane has not changed since the click (still group id ' + jidTag(jid) + ') - waiting' };
    }
    const owner = scanJidOwner.get(jid);
    if (owner && normChatName(owner) !== want) {
      return { open: false, wrongChat: owner, diag: 'the pane changed to group id ' + jidTag(jid) + ', which was already read as "' + owner + '" - not "' + name + '"' };
    }
    return { open: true, jid, proof: 'group-id',
      diag: 'header unreadable (' + hdr.diag + '); the pane changed to a new group id ' + jidTag(jid) + (act.length ? ' (highlighted row did not confirm the name)' : ' (highlighted row not readable)') };
  }

  /* A cheap fingerprint of what the message pane is showing right now: the
     tail of the first message ids + the node count. Used to prove the pane
     actually SWAPPED after a click before any group-proof is accepted. */
  function paneSignature() {
    const panel = findMainPanel();
    if (!panel) return '';
    const all = qsa(panel, '[data-id]');
    const ids = all.slice(0, 8).map(n => (n.getAttribute('data-id') || '').slice(-20));
    return all.length + '#' + ids.join('|');
  }

  /* Poll until the chat verifies. A group-proof accept must hold across
     ~0.5s against a STABLE new pane signature, so neither a mid-swap glimpse
     nor a slow re-render of the previous chat can pass (v0.5.6->v0.5.7). */
  /* v0.5.10: a verdict is only final once the page has SETTLED. WhatsApp swaps
     the header and the message pane at different moments, so the first look
     after a click often shows the previous chat or a transient state (her
     v0.5.9 log judged four methods in the same second, before anything had
     swapped). Poll for the whole wait; a "wrong chat" verdict must also hold
     steady for 1.2s before it is believed, and a later correct state wins. */
  async function waitForOpen(name, ms, aliases, ctx) {
    const end = Date.now() + (ms || 2000);
    let st = chatIsOpen(name, aliases, ctx);
    let wrongSince = 0, lastWrong = null;
    while (!st.open && Date.now() < end) {
      if (st.wrongChat) {
        if (lastWrong !== st.wrongChat) { lastWrong = st.wrongChat; wrongSince = Date.now(); }
        else if (Date.now() - wrongSince >= 1200) break;      // stable wrong chat: believe it
      } else { lastWrong = null; wrongSince = 0; }
      await sleep(180);
      st = chatIsOpen(name, aliases, ctx);
    }
    if (st.open && st.proof) {
      // a proof that is not the header must hold steady for ~0.5s on the SAME group id
      let held = 0, guard = 0;
      while (held < 2 && guard < 8) {
        guard++;
        await sleep(220);
        const s2 = chatIsOpen(name, aliases, ctx);
        if (!s2.open) return s2;
        if (s2.jid === st.jid) held++;
        else return { open: false, diag: 'the message pane is still swapping - the proof was not stable' };
      }
      if (held < 2) return { open: false, diag: 'the message pane is still swapping - the proof was not stable' };
    }
    return st;
  }

  /* The chat list can take seconds to appear after a tab reload (v0.5.4
     failed with "chat list pane not found" right after an F5). Wait for it. */
  async function waitForPane(maxMs) {
    const end = Date.now() + (maxMs || 10000);
    let pane = findChatListPane();
    while (!pane && Date.now() < end) { await sleep(400); pane = findChatListPane(); }
    return pane;
  }

  /* Is the OPEN chat a group? WhatsApp encodes the chat type in every
     message's data-id: group messages contain "@g.us", direct chats "@c.us"
     (or "@lid"). Returns true (group), false (definitely not a group) or null
     (cannot tell from messages - fall back to the header subtitle). */
  function openChatGroupStatus() {
    const panel = findMainPanel();
    if (!panel) return null;
    const ids = qsa(panel, '[data-id]').map(n => n.getAttribute('data-id') || '');
    if (ids.some(i => i.indexOf('@g.us') !== -1)) return true;
    if (ids.some(i => i.indexOf('@c.us') !== -1 || i.indexOf('@lid') !== -1 || i.indexOf('@s.whatsapp.net') !== -1)) return false;
    const header = document.querySelector('#main header');
    if (header) {
      const txt = (header.innerText || header.textContent || '').toLowerCase();
      if (/click here for (group|community) info|\d+ participants/.test(txt)) return true;
      if (/click here for contact info|^online$|typing\.\.\.|last seen/.test(txt)) return false;
    }
    return null;
  }

  /* PRIVACY: redact or drop sensitive content in a batch of messages BEFORE
     it leaves the page. OTP/bank/credential-looking messages are dropped
     whole; everything else has codes, numbers, emails and payment links
     masked. The background repeats this check before storing. */
  function sanitizeMessages(msgs) {
    const out = [];
    let dropped = 0, redacted = 0;
    (msgs || []).forEach((m) => {
      const r = gpRedactText(m && m.text);
      if (r.dropped) { dropped++; return; }
      if (r.redacted) redacted++;
      out.push(Object.assign({}, m, { text: r.text }));
    });
    return { msgs: out, dropped, redacted };
  }

  // Where the messages live. #main is the long-standing id; keep fallbacks.
  function findMainPanel() {
    return document.querySelector('#main') ||
      document.querySelector('div[role="main"]') ||
      document.querySelector('main') ||
      null;
  }

  /* Find the message bubble nodes in the open chat. WhatsApp has used all of
     these over time - try each, keep the strategy that finds the most, and
     report every count so the debug log shows what the page actually has. */
  function findMessageNodes(panel) {
    const counts = {};
    let best = [], bestName = 'none';

    const stratA = qsa(panel, 'div.message-in, div.message-out');
    counts['div.message-in/out'] = stratA.length;
    if (stratA.length > best.length) { best = stratA; bestName = 'div.message-in/out'; }

    // Message wrappers carry data-id like "true_<chat>_<id>_<sender>".
    const stratB = qsa(panel, 'div[data-id]').filter(n => /^(true|false)_/.test(n.getAttribute('data-id') || ''));
    counts['div[data-id]'] = stratB.length;
    if (stratB.length > best.length) { best = stratB; bestName = 'div[data-id]'; }

    // Newer layouts: role="row" per message inside the conversation grid.
    const stratC = qsa(panel, 'div[role="row"]').filter(n => n.querySelector('[data-pre-plain-text], span.selectable-text'));
    counts['div[role=row]'] = stratC.length;
    if (stratC.length > best.length) { best = stratC; bestName = 'div[role=row]'; }

    // Last resort: anchor on the metadata attribute itself and walk up.
    const stratD = qsa(panel, '[data-pre-plain-text]').map(n => n.closest('[data-id]') || n.parentElement).filter(Boolean);
    counts['[data-pre-plain-text] ancestors'] = stratD.length;
    if (stratD.length > best.length) { best = stratD; bestName = '[data-pre-plain-text] ancestors'; }

    /* v0.5.7: two more shapes WhatsApp has used.
       E: any element whose data-id carries a chat address, prefix or not.
       F: the copyable-text container itself (text + metadata live inside). */
    const stratE = qsa(panel, '[data-id]').filter(n => /@(g|c)\.us|@lid|@s\.whatsapp\.net|@broadcast/.test(n.getAttribute('data-id') || ''));
    counts['[data-id] with chat address'] = stratE.length;
    if (stratE.length > best.length) { best = stratE; bestName = '[data-id] with chat address'; }

    const stratF = qsa(panel, '.copyable-text').map(n => n.closest('[data-id]') || n).filter(Boolean);
    counts['.copyable-text'] = stratF.length;
    if (stratF.length > best.length) { best = stratF; bestName = '.copyable-text'; }

    // dedupe (a node can be caught by two strategies)
    const seen = new Set();
    best = best.filter(n => { if (seen.has(n)) return false; seen.add(n); return true; });
    return { nodes: best, strategy: bestName, counts };
  }

  function extractOneMessage(node) {
    const copyable = node.matches && node.matches('[data-pre-plain-text]')
      ? node : node.querySelector('[data-pre-plain-text]');
    const meta = copyable ? copyable.getAttribute('data-pre-plain-text') : null;

    /* v0.5.7: text fallback chain. innerText depends on layout and can read
       empty on freshly-rendered nodes; textContent and the copyable-text
       container catch what the class-based selector misses. */
    let textEl = node.querySelector('span.selectable-text');
    if (!textEl && copyable) textEl = copyable.querySelector('span[dir="ltr"], span[dir="auto"]');
    if (!textEl) textEl = node.querySelector('.copyable-text span[dir="ltr"], .copyable-text span[dir="auto"]');
    let text = textEl ? String(textEl.innerText || '').trim() : '';
    if (!text && textEl) text = String(textEl.textContent || '').trim();
    if (!text && copyable) {
      const own = Array.from(copyable.childNodes).map(n => n.textContent || '').join(' ').trim();
      if (own) text = own;
    }
    if (!text && node.querySelector) {
      const any = node.querySelector('span[dir="ltr"], span[dir="auto"]');
      if (any) text = String(any.innerText || any.textContent || '').trim();
    }
    if (!text) return null; // image-only / sticker / system messages: skip

    let sender = 'Unknown', timeText = '';
    if (meta) {
      // Looks like "[10:32, 16/10/2026] Sender: " (order of date/time varies by locale)
      const m = meta.match(/^\[(.*?)\]\s*(.*?):\s*$/);
      if (m) { timeText = m[1]; sender = m[2]; }
    }
    const id = node.getAttribute('data-id') ||
      (timeText + '|' + sender + '|' + text.slice(0, 60));
    // data-id starts with "true_" for messages YOU sent; class message-out too
    const mine = /^true_/.test(node.getAttribute('data-id') || '') ||
      !!(node.matches && node.matches('.message-out')) || !!node.closest('.message-out');
    if (mine) sender = 'You';
    return { id, sender, timeText, text: text.slice(0, 600) };
  }

  function extractOpenChatMessages() {
    const hdr = getOpenChatName();
    /* v0.5.6: an unreadable header (subtitle/icon/mid-transition) no longer
       stops extraction - the callers verify the chat separately and store
       under the list name when the group proof holds. */
    const group = hdr.name || null;

    const panel = findMainPanel();
    if (!panel) return { group, messages: [], note: 'the chat panel (#main) was not found - WhatsApp layout changed' };

    const r = findMessageNodes(panel);
    const msgs = [];
    const seenIds = new Set();
    r.nodes.forEach((node) => {
      try {
        const m = extractOneMessage(node);
        if (m && !seenIds.has(m.id)) { seenIds.add(m.id); msgs.push(m); }
      } catch (e) { /* keep going on a weird message node */ }
    });

    const countStr = Object.keys(r.counts).map(k => k + '=' + r.counts[k]).join(', ');
    const diag = 'open chat "' + (group || '(header unreadable)') + '" (' + hdr.diag + '): ' + msgs.length + ' readable message(s) via ' + r.strategy +
      ' (tried: ' + countStr + ')';
    const note = msgs.length > 0 ? 'ok'
      : (r.nodes.length > 0 ? 'message nodes found but none had readable text - text selector broke'
         : 'no message nodes found - WhatsApp may have changed its layout');
    return { group, messages: msgs, note, diag };
  }

  /* ---------- chat-list extraction ---------- */

  const TIME_LINE = /^(\d{1,2}:\d{2}(\s?[AP]\.?M\.?)?|Yesterday|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4})$/i;

  // The left sidebar. #pane-side is the long-standing id; keep fallbacks.
  function findChatListPane() {
    return document.querySelector('#pane-side') ||
      document.querySelector('div[aria-label*="chat list" i]') ||
      document.querySelector('div[aria-label*="chats" i]') ||
      document.querySelector('[data-testid="chat-list"]') ||
      null;
  }

  /* Chat rows inside the sidebar. Try every known shape, use whichever finds
     rows, and report all counts. */
  function findChatRows(pane) {
    const counts = {};
    let best = [], bestName = 'none';
    const strategies = {
      'div[role="listitem"]': 'div[role="listitem"]',
      'div[role="row"]': 'div[role="row"]',
      'li': 'li',
      'div[tabindex] with title span': 'div[tabindex]'
    };
    Object.keys(strategies).forEach((name) => {
      let rows = qsa(pane, strategies[name]);
      if (name === 'div[tabindex] with title span') rows = rows.filter(n => n.querySelector('span[title]'));
      counts[name] = rows.length;
      // only accept strategies whose rows actually look like chat rows
      const usable = rows.filter(n => n.querySelector('span[title]') || (n.innerText || '').trim());
      if (usable.length > best.length) { best = usable; bestName = name; }
    });
    return { rows: best, strategy: bestName, counts };
  }

  /* Row text as lines, like innerText but SKIPPING the unread-count badge and
     the @-mention marker. Those change whenever a message arrives or the chat
     is opened; keeping them out makes the "already read" signature (readSig)
     stable, so a chat GroupPing opened itself is not immediately re-opened.
     (innerText on a detached clone loses line breaks, so we walk the live DOM.) */
  function rowTextLines(row) {
    const skip = new Set();
    row.querySelectorAll('span[aria-label*="unread" i], span[aria-label*="mention" i]').forEach((n) => {
      skip.add(n); n.querySelectorAll('*').forEach(x => skip.add(x));
    });
    const out = [];
    (function walk(el) {
      if (skip.has(el)) return;
      if (el.nodeType === 3) { out.push(el.textContent); return; }
      if (el.nodeType !== 1) return;
      if (el.tagName === 'SPAN' && (el.textContent || '').trim() === '@') return; // @-mention marker
      /* A titled span (chat name, community label, sometimes the preview)
         starts its own line: WhatsApp usually keeps name, community label and
         time in separate boxes, but layouts change - splitting here keeps the
         time and the community label out of the preview even when they share
         one box (that gluing broke group detection in v0.5.3). */
      if (el.tagName === 'SPAN' && el.getAttribute('title')) { out.push('\n'); el.childNodes.forEach(walk); out.push('\n'); return; }
      if (el.tagName === 'BR') { out.push('\n'); return; }
      el.childNodes.forEach(walk);
      if (/^(DIV|P|LI|TR|TD|SECTION|HEADER|FOOTER|H[1-6])$/.test(el.tagName)) out.push('\n');
    })(row);
    return out.join('').split('\n');
  }

  /* The chat NAME inside a row. Community groups show the community name as a
     small grey line next to the group name, and both can carry a title= -
     taking the first span[title] then collapses every community group into
     one entry. The chat name is always the most prominent (largest) titled
     text on the row; the community label and the preview are smaller.
     Returns { name, aliases } where aliases are other titled texts sharing
     the name's top line (the community label), so previews can drop them. */
  function chatRowName(row) {
    const spans = qsa(row, 'span[title]').map((el) => {
      let fs = 0;
      try { fs = parseFloat(getComputedStyle(el).fontSize) || 0; } catch (e) {}
      let top = 0;
      try { top = el.getBoundingClientRect().top; } catch (e) {}
      return { el, text: (el.getAttribute('title') || el.textContent || '').trim(), fs, top };
    }).filter(s => s.text);
    if (!spans.length) return { name: '', aliases: [] };
    const maxFs = Math.max.apply(null, spans.map(s => s.fs));
    const best = spans.filter(s => s.fs >= maxFs - 0.5)[0] || spans[0];
    const aliases = spans.filter(s => s !== best && Math.abs(s.top - best.top) < 6).map(s => s.text);
    return { name: best.text, aliases };
  }

  /* v0.5.7: every name-like line a row carries. A community subgroup's row
     (in the chat list AND in search results) shows the community label on one
     line and the GROUP name on another - v0.5.6 matched rows only by their
     single "biggest" title, so community subgroups were never found and the
     community itself got clicked instead. Matching by ANY line finds them;
     the post-click header check still guarantees the right chat opened. */
  function rowNameCandidates(row) {
    const out = [];
    const seen = new Set();
    const push = (v) => {
      v = String(v == null ? '' : v).replace(/[\u00A0\u200B-\u200D\uFE0F\u200e\u200f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (v && v.length < 90 && !seen.has(v)) { seen.add(v); out.push(v); }
    };
    qsa(row, 'span[title]').forEach(el => push(el.getAttribute('title') || el.textContent));
    rowTextLines(row).forEach(l => {
      const t = String(l || '').trim();
      if (t && !TIME_LINE.test(t) && !/^\d+$/.test(t) && t !== '@') push(t);
    });
    return out;
  }

  /* All rows on screen that carry `name` on ANY of their lines, best first
     (rows whose PRIMARY/big title is the name, then the rest). */
  function findRowsForName(name) {
    const want = normChatName(name);
    const pane = findChatListPane();
    const out = [];
    if (!pane || !want) return out;
    findChatRows(pane).rows.forEach((row) => {
      if (rowNameCandidates(row).some(t => normChatName(t) === want)) out.push(row);
    });
    out.sort((a, b) =>
      (normChatName(chatRowName(b).name) === want ? 1 : 0) - (normChatName(chatRowName(a).name) === want ? 1 : 0));
    return out;
  }

  /* WhatsApp's own chat-list filter chips ("All", "Unread", "Favourites",
     "Groups", custom labels). Switching "Groups" on makes WhatsApp itself
     list only groups - no guessing from icons or preview text. GroupPing only
     ever switches the filter and switches it back; nothing else is clicked. */
  function findFilterChip(label) {
    const pane = findChatListPane();
    if (!pane) return null;
    const paneBox = pane.getBoundingClientRect();
    const want = label.toLowerCase();
    const cands = qsa(document, '[role="tab"], [role="button"], button, li, div, span').filter((el) => {
      const t = (el.textContent || '').trim().toLowerCase();
      if (t !== want && !t.startsWith(want + ' ')) return false; // "Groups" or "Groups 61"
      if (t.length > want.length + 8) return false;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;                    // hidden
      if (r.left > paneBox.left + paneBox.width + 60) return false; // must sit over the chat-list column
      if (r.top > paneBox.top + 80 || r.bottom < paneBox.top - 220) return false; // chips sit just above the list
      return true;
    });
    cands.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    const el = cands[0];
    if (!el) return null;
    return el.closest('[role="tab"], [role="button"], button') || el;
  }

  async function setGroupsFilter(on) {
    const label = on ? 'Groups' : 'All';
    const chip = findFilterChip(label);
    if (!chip) {
      log('chat-list filter chip "' + label + '" not found on this WhatsApp layout - ' +
          (on ? 'falling back to built-in group signals (group icon, @-mention, "~Sender:" preview)' : 'leaving the filter as it was'));
      groupsFilterActive = false;
      return false;
    }
    fireClickSequence(chip);
    await sleep(800);
    groupsFilterActive = on;
    log('chat-list filter "' + label + '" switched ' + (on ? 'ON - WhatsApp is now listing groups only' : 'OFF - back to all chats'));
    return true;
  }

  /* Wait until the virtualised chat list has rendered at least one row
     (jumping the scroll position blanks the list for a moment). */
  async function waitForRows(maxMs) {
    const end = Date.now() + (maxMs || 1500);
    let n = 0;
    do {
      const pane = findChatListPane();
      n = pane ? findChatRows(pane).rows.length : 0;
      if (n > 0) return n;
      await sleep(200);
    } while (Date.now() < end);
    return 0;
  }

  function parseChatRow(row) {
    const nr = chatRowName(row);
    const name = nr.name;
    if (!name) return null;

    const lines = rowTextLines(row).map(s => s.trim()).filter(Boolean);
    const tsText = lines.find(l => TIME_LINE.test(l)) || '';
    const preview = lines
      .filter(l => l !== name && nr.aliases.indexOf(l) === -1 && l !== tsText && !/^\d+$/.test(l) && l !== '@')
      .join(' ').slice(0, 300);

    let unread = 0;
    const badge = row.querySelector('span[aria-label*="unread" i]');
    if (badge) {
      const m = ((badge.getAttribute('aria-label') || '') + ' ' + badge.textContent).match(/(\d+)/);
      unread = m ? parseInt(m[1], 10) : 1;
    }

    const mention = !!row.querySelector('span[aria-label*="mention" i]') ||
      Array.from(row.querySelectorAll('span')).some(s => s.textContent.trim() === '@');

    const muted = !!row.querySelector('span[data-icon="muted"], span[aria-label*="muted" i]');

    const isYou = /^You:\s?/i.test(preview);
    /* STRICT positive group identification (v0.5.4 privacy rule): a chat
       counts as a group only with POSITIVE evidence -
       - WhatsApp's own "Groups" filter is on (every listed row is a group),
       - the row carries a group/community icon or the default group avatar,
       - it has an @-mention badge (WhatsApp shows @ only in groups),
       - the preview starts with a "~Sender: " prefix (the tilde marks a
         sender who is not in your contacts - groups only), or with a plain
         "Sender: " prefix that cannot be mistaken for message text,
       - a previous verified open of this chat confirmed it (sticky in merge).
       A plain "Word: text" preview alone is NOT enough - direct-chat messages
       often start with "PS:", "Note:", "Happy Birthday:" etc. Anything
       ambiguous is treated as NOT a group and never stored, opened or read.
       groupWhy records WHICH signal fired, for the Debug log. */
    const groupIcon = !!row.querySelector('span[data-icon*="group" i], span[data-icon*="community" i], svg[data-icon*="group" i], svg[aria-label*="group" i], span[aria-label*="group" i], img[src*="group"], img[alt*="group" i], [data-testid*="group" i]');
    const tildeSender = !isYou && /^~[^:]{1,40}:\s/.test(preview);
    const senderM = !isYou && preview.match(/^([^:]{3,40}):\s/);
    /* Message texts often start with "Word:" and fool a plain sender check
       ("PS: ...", "Happy Birthday: ..."). If the FIRST word of the prefix is
       a common message opener, the prefix is message text, not a sender. */
    const NOT_A_SENDER_WORD = new Set(['ps', 'p.s', 're', 'fw', 'fwd', 'note', 'fyi', 'reminder', 'important', 'urgent', 'update', 'alert', 'otp',
      'dear', 'hi', 'hii', 'hello', 'hey', 'happy', 'sorry', 'thanks', 'thank', 'please', 'link', 'bro', 'broo', 'sis', 'guys', 'all', 'everyone',
      'today', 'tonight', 'tomorrow', 'good', 'greetings', 'sir', 'madam', 'offer', 'discount', 'sale', 'deal', 'order', 'payment', 'invoice',
      'winner', 'congratulations', 'news', 'question', 'query', 'help', 'info', 'meeting', 'call', 'class', 'party', 'reminder:']);
    const firstWord = senderM ? (senderM[1].trim().split(/\s+/)[0] || '').toLowerCase().replace(/\.+$/, '') : '';
    const plainSender = !!senderM && !NOT_A_SENDER_WORD.has(firstWord);
    let isGroup = groupIcon || mention || tildeSender || plainSender;
    let groupWhy = groupIcon ? 'group icon/avatar' : mention ? '@-mention badge' :
      tildeSender ? '"~Sender:" preview prefix' : plainSender ? '"Sender:" preview prefix' : '';
    if (groupsFilterActive && !isGroup) { isGroup = true; groupWhy = "WhatsApp's own Groups filter"; }
    const whyNot = isGroup ? '' : 'no group icon, no @-mention, no "~Sender:"/"Sender:" preview prefix';

    const lastTs = gpParseChatTime(tsText);
    return {
      name, aliases: nr.aliases, tsText, preview, unread, mention, muted, isYou, isGroup, groupWhy, whyNot,
      verifiedGroup: groupsFilterActive && isGroup ? true : undefined, // seen under WhatsApp's own filter = certain
      everSent: isYou, // becomes sticky in mergeChatList: true once you were ever the last sender
      lastTs: lastTs || null,
      seenAt: Date.now()
    };
  }

  function harvestChatList() {
    const pane = findChatListPane();
    if (!pane) {
      return { found: {}, diag: 'chat list pane not found on screen (tried #pane-side, aria-label, data-testid)', rejected: [] };
    }
    const r = findChatRows(pane);
    const found = {};
    const rejected = [];
    let skipped = 0, excluded = 0, nonGroup = 0;
    r.rows.forEach((row) => {
      try {
        const parsed = parseChatRow(row);
        if (!parsed) { skipped++; return; }
        if (gpIsExcludedChat(parsed.name)) { excluded++; rejected.push(parsed.name + ' (on the never-track list)'); return; }
        if (!parsed.isGroup) { nonGroup++; if (rejected.length < 40) rejected.push(parsed.name + ' (' + (parsed.whyNot || 'no group signal') + ')'); return; } // PRIVACY: direct chats / unknown rows are never tracked
        found[parsed.name] = parsed;
      } catch (e) { skipped++; }
    });
    const countStr = Object.keys(r.counts).map(k => k + '=' + r.counts[k]).join(', ');
    const diag = 'chat list: ' + Object.keys(found).length + ' group(s) read via ' + r.strategy +
      (nonGroup ? ' (' + nonGroup + ' non-group chat(s) ignored)' : '') +
      (skipped ? ' (' + skipped + ' row(s) skipped)' : '') +
      (excluded ? ' (' + excluded + ' excluded chat(s) ignored)' : '') + ' (tried: ' + countStr + ')';
    return { found, diag, rowCount: r.rows.length, nonGroup, rejected };
  }

  function mergeChatList(found, done) {
    const names = Object.keys(found);
    if (!names.length) { if (done) done(0); return; }
    chrome.storage.local.get([GP.STORE.CHATLIST, GP.STORE.SELGROUPS], (d) => {
      const store = d[GP.STORE.CHATLIST] && typeof d[GP.STORE.CHATLIST] === 'object' ? d[GP.STORE.CHATLIST] : {};
      const selected = gpSelectedGroups(d[GP.STORE.SELGROUPS]);
      names.forEach((n) => {
        const prev = store[n];
        const entry = found[n]; // latest view of the row wins
        /* An explicit purge (the chat was OPENED and WhatsApp proved it is not
           a group) must survive the sticky rules below - otherwise the purge
           flips straight back (v0.5.3 bug). The marker stays until WhatsApp's
           own Groups filter or a fresh open proves it IS a group. */
        const explicitPurge = entry.isGroup === false && entry.purgeGroup === true;
        delete entry.purgeGroup;
        if (prev && prev.everSent === true) entry.everSent = true; // you wrote there at some point - remember
        if (prev && entry.aliases === undefined && prev.aliases) entry.aliases = prev.aliases; // community label(s) survive re-scans
        if (prev && entry.readSig === undefined && prev.readSig) entry.readSig = prev.readSig; // last row state we opened and read
        if (prev && prev.notGroupAt && entry.verifiedGroup !== true) { entry.isGroup = false; entry.notGroupAt = prev.notGroupAt; }
        else if (explicitPurge) { entry.isGroup = false; entry.notGroupAt = Date.now(); }
        else if (prev && prev.isGroup === true) entry.isGroup = true;  // once verified as a group, stays one
        if (prev && prev.isCommunity && entry.isCommunity === undefined) entry.isCommunity = true;
        if (prev && prev.verifiedGroup === true) entry.verifiedGroup = true;  // certain-group marking survives re-scans
        if (entry.verifiedGroup === true) delete entry.notGroupAt;    // fresh certain proof clears an old marker
        /* PRIVACY: the last-message preview is message content. It is stored
           ONLY for groups you turned on, and always redacted first. For every
           other group only the name, time, unread count and badges are kept -
           enough to list the group and to rank a reply reminder. */
        if (selected.has(n)) {
          const red = gpRedactText(entry.preview || '');
          entry.preview = red.dropped ? '' : red.text;
        } else {
          entry.preview = '';
        }
        store[n] = entry;
      });
      // remove excluded chats and anything not positively a group (privacy purge, also
      // covers older versions' rows). Verified non-group markers are kept, so a
      // proven direct chat is never re-added by a later heuristic guess.
      Object.keys(store).forEach((n) => {
        if (gpIsExcludedChat(n) || (store[n].isGroup !== true && !store[n].notGroupAt)) delete store[n];
      });
      // cap the store so an old phone with thousands of chats does not fill storage
      const keys = Object.keys(store);
      if (keys.length > 1000) {
        keys.sort((a, b) => (store[a].seenAt || 0) - (store[b].seenAt || 0));
        keys.slice(0, keys.length - 1000).forEach(k => delete store[k]);
      }
      chrome.storage.local.set({ [GP.STORE.CHATLIST]: store }, () => { if (done) done(names.length); });
    });
  }

  /* ---------- scroll-to-load-all scan ----------
     WhatsApp only creates rows for chats near the scroll position, so to learn
     about ALL chats we scroll the list step by step and harvest each screen.
     This only scrolls the page - it never clicks, opens or sends anything. */
  let scanning = false;
  /* True while WhatsApp's own "Groups" chat-list filter is switched on by a
     GroupPing scan. When it is on, every row in the list IS a group (WhatsApp
     itself filtered the list) - the strongest group signal there is. */
  let groupsFilterActive = false;
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Find the element that actually scrolls (walk up from a chat row).
  function findScroller(startEl) {
    let el = startEl;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 40) {
        const oy = (getComputedStyle(el).overflowY || '');
        if (oy === 'auto' || oy === 'scroll' || el.id === 'pane-side') return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  async function scanAllChats() {
    if (scanning) return { ok: false, error: 'a scan is already running' };
    const first = harvestChatList();
    if (!first.rowCount) {
      return { ok: false, error: 'chat list not found on screen. ' + first.diag + '. Is WhatsApp Web loaded and showing your chats?' };
    }
    const pane = findChatListPane();
    const scroller = findScroller(pane) || pane;
    scanning = true;
    const originalScroll = scroller.scrollTop;
    let total = 0, stuck = 0, lastTop = -1, oldScreens = 0;
    let winDays = GP.DEFAULT_WINDOW_DAYS;
    try {
      const sd = await chrome.storage.local.get(GP.STORE.SETTINGS);
      winDays = Math.min(365, Math.max(1, parseInt((sd[GP.STORE.SETTINGS] || {}).windowDays, 10) || GP.DEFAULT_WINDOW_DAYS));
    } catch (e) {}
    const windowStart = Date.now() - winDays * 86400000;
    try {
      scroller.scrollTop = 0;
      await sleep(500);
      for (let step = 0; step < 80 && stuck < 3; step++) {
        const h = harvestChatList();
        const stamps = Object.keys(h.found).map(n => h.found[n].lastTs).filter(Boolean);
        if (stamps.length && Math.max.apply(null, stamps) < windowStart) {
          oldScreens++;
          if (oldScreens >= 2) { log('chat-list scan stopped at the ' + winDays + '-day window'); break; }
        } else oldScreens = 0;
        mergeChatList(h.found);
        if (scroller.scrollTop === lastTop) stuck++; else stuck = 0;
        lastTop = scroller.scrollTop;
        scroller.scrollTop += Math.max(200, Math.floor(scroller.clientHeight * 0.8));
        await sleep(450); // give WhatsApp a moment to render the next rows
      }
      mergeChatList(harvestChatList().found);
      const d = await chrome.storage.local.get(GP.STORE.CHATLIST);
      total = Object.keys(d[GP.STORE.CHATLIST] || {}).length;
      scroller.scrollTop = originalScroll; // put the list back where you left it
      log('chat-list scan finished: ' + total + ' chats known');
      return { ok: true, count: total };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      scanning = false;
    }
  }


  /* ---------- sending messages to the background (single writer) ---------- */

  function sendBatches(batches, done) {
    const useful = batches.filter(b => b.group && b.messages.length);
    if (!useful.length) { if (done) done(0); return; }
    try {
      chrome.runtime.sendMessage({ type: 'gp-store', batches: useful }, (r) => {
        if (chrome.runtime.lastError) { if (done) done(0); return; }
        if (done) done((r && r.added) || 0);
      });
    } catch (e) { if (done) done(0); } // extension was reloaded: this old script is stale, F5 the tab
  }

  /* ---------- reading the open chat ---------- */

  let collecting = false;
  let lastDiag = null;
  const sentIds = new Set(); // ids already handed to the background in this page session (cheap re-read guard)

  function collect(reason, done) {
    if (collecting || scanning) { if (done) done(lastDiag); return; }
    collecting = true;
    const diag = { reason, at: Date.now() };
    try {
      chrome.storage.local.get(GP.STORE.SELGROUPS, (sd) => {
        const selected = gpSelectedGroups(sd[GP.STORE.SELGROUPS]);
        const res = extractOpenChatMessages();
        diag.openChat = res.diag || res.note;
        if (res.group && gpIsExcludedChat(res.group)) {
          diag.openChat = 'open chat "' + res.group + '" is on the exclude list - not stored';
          res.group = null; res.messages = [];
        }
        /* PRIVACY: the chat on screen is read only when it is a group you
           turned on. A direct chat (or a group not selected) is never read,
           even while you are looking at it. */
        if (res.group && !selected.has(res.group)) {
          diag.openChat = 'open chat "' + res.group + '" is not a selected group - not read';
          res.group = null; res.messages = [];
        }
        if (res.group) {
          const gst = openChatGroupStatus();
          /* STRICT (v0.5.4): read only when the open chat is POSITIVELY a
             group. "Cannot tell" (null) is treated as not-a-group. */
          if (gst !== true) {
            diag.openChat = 'open chat "' + res.group + '" ' + (gst === false ? 'is not a group' : 'could not be verified as a group') + ' - never read';
            if (gst === false) mergeChatList({ [res.group]: { name: res.group, isGroup: false, preview: '', purgeGroup: true, seenAt: Date.now() } }); // purge the misdetection
            res.group = null; res.messages = [];
          } else if (res.messages.length) {
            // register the open verification so every later gate knows this chat is certainly a group
            mergeChatList({ [res.group]: { name: res.group, isGroup: true, verifiedGroup: true, lastTs: Date.now(), preview: '', seenAt: Date.now() } });
            const san = sanitizeMessages(res.messages.filter(m => !sentIds.has(res.group + '|' + m.id)));
            san.msgs.forEach(m => sentIds.add(res.group + '|' + m.id));
            if (san.dropped) log('"' + res.group + '": dropped ' + san.dropped + ' sensitive message(s) (OTP/bank/credentials) - never stored');
            sendBatches([{ group: res.group, messages: san.msgs }], (added) => {
              if (added > 0) log('stored ' + added + ' new message(s) from "' + res.group + '" (' + reason + ')');
            });
            if (res.note !== 'ok') log('WARNING: ' + res.note + ' (' + (res.diag || '') + ')');
          }
        }
        const h = harvestChatList();
        diag.chatList = h.diag;
        mergeChatList(h.found, () => {
          lastDiag = diag; collecting = false;
          if (done) done(diag);
        });
      });
    } catch (e) {
      log('ERROR during collect: ' + (e && e.message));
      lastDiag = diag; collecting = false;
      if (done) done(diag);
    }
  }

  /* ---------- progress shown in the popup ---------- */

  let lastProgressWrite = 0;
  function progress(p, force) {
    const now = Date.now();
    if (!force && now - lastProgressWrite < 400) return;
    lastProgressWrite = now;
    try { chrome.storage.local.set({ [GP.STORE.PROGRESS]: Object.assign({ ts: now }, p) }); } catch (e) {}
  }

  /* ---------- clicking a chat row (never types, never sends) ---------- */

  function fire(el, type) {
    const Ctor = /^pointer/.test(type) && window.PointerEvent ? window.PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: 1 }));
  }

  /* WhatsApp (React) opens a chat from pointer+mouse events, but WHICH element
     carries the handler changes between layouts. Try every plausible clickable
     in turn and VERIFY the chat header actually changed before moving on.
     Every attempt is written to the Debug log. */
  function clickCandidates(row) {
    const out = [];
    const add = (el, label) => { if (el && el.nodeType === 1 && !out.some(c => c.el === el)) out.push({ el, label }); };
    const nameEl = row.querySelector('span[title]');
    /* v0.5.7: order by what actually opened chats on her live page - the
       gridcell around the name worked every time; the tabindex divs never
       did, and trying them first cost ~2s per group per candidate. */
    if (nameEl) add(nameEl.closest('[role="gridcell"]'), 'gridcell around the name');
    add(row, 'the row itself');
    add(row.closest('[role="row"]'), 'closest [role=row]');
    add(row.querySelector('div[tabindex][role="button"]'), 'inner div[tabindex][role=button]');
    add(row.querySelector('div[tabindex]'), 'inner div[tabindex]');
    add(row.closest('[role="listitem"]'), 'closest [role=listitem]');
    return out;
  }

  function fireClickSequence(el) {
    try { el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
    ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t => fire(el, t));
  }

  /* Try to open `name` by clicking its row, element by element, verifying
     after EVERY attempt that this exact chat is on screen. v0.5.5: also fires
     the element's native click handler and a keyboard Enter (WhatsApp rows
     open on Enter when focused), and the verification compares names
     forgivingly with full diagnostics. */
  function pressEnter(el) {
    try {
      el.focus();
      ['keydown', 'keypress', 'keyup'].forEach(t => el.dispatchEvent(
        new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })));
    } catch (e) {}
  }
  /* v0.5.9: restores the methods that actually opened chats on her live page
     in v0.5.7 (a plain click often does nothing there; Enter on the row's
     inner div[tabindex] and Enter on the search result do). Method order:
       1 click the gridcell around the name
       2 Enter on the inner div[tabindex]            <- worked live in v0.5.7
       3 Enter on the gridcell / the row
       4 click the row itself
     Every attempt is judged against the pane as it was BEFORE it (group id),
     so a method that only "seems" to work is never trusted: header match, or
     highlighted row + changed pane, or a new unseen group id. */
  async function tryOpenByClick(name, row, aliases) {
    const ctx = { beforeJid: paneJid(), beforeSig: paneSignature(), prevName: getOpenChatName().name };
    const cands = clickCandidates(row);
    const byLabel = (re) => cands.find(c => re.test(c.label));
    const tab = row.querySelector('div[tabindex]');
    const grid = byLabel(/gridcell/);
    const methods = [];
    if (grid) methods.push({ label: 'click on the gridcell around the name', run: () => { fireClickSequence(grid.el); try { grid.el.click(); } catch (e) {} }, wait: 3500 });
    if (tab) methods.push({ label: 'keyboard (Enter) on the inner div[tabindex]', run: () => pressEnter(tab), wait: 3500 });
    if (grid) methods.push({ label: 'keyboard (Enter) on the gridcell', run: () => pressEnter(grid.el), wait: 2500 });
    methods.push({ label: 'click on the row itself', run: () => { fireClickSequence(row); try { row.click(); } catch (e) {} }, wait: 2500 });
    for (const m of methods) {
      m.run();
      const st = await waitForOpen(name, m.wait, aliases, ctx);
      if (st.open) { log('opened chat "' + name + '" by ' + m.label + ' - ' + st.diag); return true; }
      if (st.wrongChat && ANNOUNCE.test(cleanHeaderText(st.wrongChat))) {
        communityNames.add(name);
        log('"' + name + '" opens "' + st.wrongChat + '" - it is a Community container (its messages live in its subgroups), not a group. Not retrying.');
        return false;
      }
      if (st.wrongChat) { log('opening "' + name + '": ' + m.label + ' opened "' + st.wrongChat + '" instead (' + st.diag + ') - trying the next method'); continue; }
      log('opening "' + name + '": ' + m.label + ' did not open it (' + st.diag + ')');
    }
    return false;
  }

  /* Backwards-compatible single-click helper (still used in a couple of spots). */
  function clickRow(row) {
    const c = clickCandidates(row)[0];
    if (c) fireClickSequence(c.el);
  }

  function rowsByName() {
    const pane = findChatListPane();
    const map = new Map();
    if (!pane) return map;
    findChatRows(pane).rows.forEach((row) => {
      const name = chatRowName(row).name;
      if (name && !map.has(name)) map.set(name, row);
    });
    return map;
  }

  async function waitFor(fn, ms, step) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await sleep(step || 200); }
    return !!fn();
  }

  /* Open a chat and wait until its header and messages are on screen. */
  async function openAndWait(name, row) {
    const ok = await tryOpenByClick(name, row);
    if (!ok) return false; // tryOpenByClick already logged why (header compare incl.)
    let prev = -1;
    await waitFor(() => {
      const panel = findMainPanel();
      const n = panel ? findMessageNodes(panel).nodes.length : 0;
      const stable = n > 0 && n === prev;
      prev = n;
      return stable;
    }, 3500, 350);
    return true;
  }

  /* Wait until the open chat's messages have rendered and stopped changing
     (v0.5.6: v0.5.5 read the pane the instant the header matched, before
     WhatsApp had drawn a single message - that is the "opened but 0 read"
     symptom). Returns the message-node count, 0 on timeout. */
  async function waitForMessages(ms) {
    const end = Date.now() + (ms || 4000);
    let prev = -1, stable = 0;
    while (Date.now() < end) {
      const panel = findMainPanel();
      const n = panel ? findMessageNodes(panel).nodes.length : 0;
      if (n > 0 && n === prev) { stable++; if (stable >= 2) return n; } else stable = 0;
      prev = n;
      await sleep(250);
    }
    return prev > 0 ? prev : 0;
  }

  async function loadMoreHistory(times) {
    const panel = findMainPanel();
    const first = panel && findMessageNodes(panel).nodes[0];
    const sc = first && findScroller(first);
    if (!sc) return;
    for (let i = 0; i < times; i++) { sc.scrollTop = 0; await sleep(900); }
    sc.scrollTop = sc.scrollHeight;
    await sleep(300);
  }

  /* The element that scrolls the OPEN CHAT's messages (not the chat list). */
  function msgScroller() {
    const panel = findMainPanel();
    const first = panel && findMessageNodes(panel).nodes[0];
    return (first && findScroller(first)) || null;
  }

  function oldestTs(byId) {
    let oldest = null;
    byId.forEach((m) => {
      const at = gpParseMsgTime(m.timeText);
      if (at && (!oldest || at < oldest)) oldest = at;
    });
    return oldest;
  }

  /* v0.5.7: read the open chat PROPERLY. WhatsApp virtualises messages - only
     what is on screen exists in the DOM - so a first scan must SCROLL UP,
     harvesting every screen and merging by message id, until the oldest
     message on screen is older than the look-back window (or history stops
     loading). Later scans skip the dig (readSig covers it) unless the chat
     shows a big unread pile. Returns the merged message list + diagnostics. */
  async function readGroupHistory(windowStart, deep) {
    const byId = new Map();
    let lastNote = '', lastDiag = '';
    const harvest = () => {
      const r = extractOpenChatMessages();
      lastNote = r.note; lastDiag = r.diag;
      r.messages.forEach((m) => { if (!byId.has(m.id)) byId.set(m.id, m); });
      return r.messages.length;
    };
    harvest();
    let rounds = 0, noProgress = 0;
    const maxRounds = deep ? 14 : 0;
    while (rounds < maxRounds) {
      const oldest = oldestTs(byId);
      if (oldest && oldest <= windowStart) break;   // reached the window edge
      const sc = msgScroller();
      if (!sc) break;
      const sig0 = paneSignature();
      const before = byId.size;
      sc.scrollTop = Math.max(0, sc.scrollTop - Math.floor(sc.clientHeight * 0.85));
      if (sc.scrollTop < 150) sc.scrollTop = 0;     // near the top: force a history load
      await waitFor(() => paneSignature() !== sig0, 2500, 200);
      harvest();
      if (byId.size === before && paneSignature() === sig0) noProgress++; else noProgress = 0;
      rounds++;
      if (noProgress >= 2) break;                   // no more history to load
    }
    const sc2 = msgScroller();
    if (sc2 && rounds) { sc2.scrollTop = sc2.scrollHeight; await sleep(250); harvest(); }
    const oldest = oldestTs(byId);
    return { messages: Array.from(byId.values()), note: lastNote, diag: lastDiag,
      historyRounds: rounds,
      reachedWindow: !!(oldest && oldest <= windowStart),
      noTimestamps: !oldest };
  }

  /* rowsByName() with a forgiving (normalised) name match. */
  function rowByNameNorm(name) {
    const want = normChatName(name);
    const all = rowsByName();
    for (const [n, r] of all) { if (normChatName(n) === want) return r; }
    return null;
  }

  /* Walk the chat list top to bottom and look for `name`; returns the row or null. */
  async function findRowByName(name, scroller) {
    scroller.scrollTop = 0; await sleep(400);
    let stuck = 0, last = -1;
    for (let i = 0; i < 18 && stuck < 3; i++) {  // v0.5.7: 60 steps cost ~20s per missing group
      const r = rowsByName().get(name) || rowByNameNorm(name);
      if (r) return r;
      if (scroller.scrollTop === last) stuck++; else stuck = 0;
      last = scroller.scrollTop;
      scroller.scrollTop += Math.max(200, Math.floor(scroller.clientHeight * 0.8));
      await sleep(350);
    }
    return null;
  }

  function wantsRead(name, e, mutesAll, now, windowStart, selected) {
    if (!e || gpIsExcludedChat(name)) return false;
    if (!selected || !selected.has(name)) return false;   // PRIVACY: opt-in only - never read a group you did not turn on
    if (mutesAll.has(name)) return false;
    if (!e.isGroup) return false;                         // GroupPing reads groups; direct chats are never opened
    if (e.muted && !e.mention) return false;              // muted in WhatsApp: skip unless someone @-mentioned you
    if (!e.lastTs || e.lastTs < windowStart) return false; // outside the look-back window (or age unknown): never open
    const sig = (e.tsText || '') + '|' + (e.preview || '');
    if (e.readSig && e.readSig === sig && !(e.unread > 0)) return false;   // nothing new since last read
    if (!e.readSig && now - e.lastTs > 2 * 86400000) return false;         // first run: only recent activity
    return true;
  }

  /* v0.5.7: read one opened group end to end - wait for ITS messages (not
     the previous chat's), verify, dig history on first scans, extract,
     redact, store. Every group logs the full accounting her logs were
     missing: extracted / in-window / sensitive-dropped / stored-new /
     already-stored. Returns 'stored' | 'empty' | 'failed'. */
  /* masked structure of the ids on screen, to diagnose chats the group proof cannot classify */
  function idShapeLog(name) {
    try {
      const panel = findMainPanel();
      const ids = panel ? qsa(panel, '[data-id]').map(n => n.getAttribute('data-id') || '') : [];
      const kinds = {};
      ids.forEach((i) => { const m = i.match(/@([a-z.]+)/g); const k = m ? m.join('+') : 'no-@'; kinds[k] = (kinds[k] || 0) + 1; });
      log('id shapes for "' + name + '": ' + ids.length + ' data-id nodes, kinds ' + JSON.stringify(kinds) +
        (ids[0] ? ', first (digits masked): ' + ids[0].replace(/\d/g, '#').slice(0, 60) : ''));
    } catch (e) {}
  }
  async function openReadStore(name, e, winDays, windowStart) {
    let mcount = await waitForMessages(9000);
    if (!mcount) {
      // v0.5.8: nudge the pane (scroll to the newest message) and wait longer once
      const scn = msgScroller();
      if (scn) { try { scn.scrollTop = scn.scrollHeight; } catch (e) {} }
      mcount = await waitForMessages(7000);
    }
    if (!mcount) {
      log('"' + name + '": chat is open but no messages rendered after 16s (message panel ' + (findMainPanel() ? 'present' : 'missing') + ', [data-id] nodes: ' + qsa(findMainPanel(), '[data-id]').length + ') - skipped this round');
      return 'failed';
    }
    /* PRIVACY (STRICT): verify the open chat POSITIVELY is a group before
       reading a single message. "Cannot tell" is treated as not-a-group. */
    let gst = openChatGroupStatus();
    if (gst !== true) idShapeLog(name);
    /* v0.5.10: when no message id classifies the chat (gst null) but the header
       positively shows this name and the chat list already proved it a group,
       read it - only a direct-chat id (@c.us / @lid) is a hard stop. */
    if (gst === null && e.isGroup === true) {
      const hp = chatIsOpen(name, e.aliases, { requirePositive: true });
      if (hp.open) { log('"' + name + '": message ids do not say group or direct, but ' + hp.diag + ' and the chat list proved it is a group - reading it'); gst = true; }
    }
    if (gst !== true) {
      log('"' + name + '" ' + (gst === false ? 'is not a group (direct chat / broadcast)' : 'could not be verified as a group') + ' - never read' + (gst === false ? ', removing it from the group list' : ''));
      if (gst === false) await new Promise(r => mergeChatList({ [name]: Object.assign({}, e, { isGroup: false, preview: '', purgeGroup: true }) }, r));
      return 'failed';
    }
    const firstScan = !e.readSig;
    const rr = await readGroupHistory(windowStart, firstScan || (e.unread || 0) > 15);
    const chk = chatIsOpen(name, e.aliases, { requirePositive: false }); // store-time re-verification
    if (!chk.open) {
      log('"' + name + '" seemed open but could not be verified (' + chk.diag + ') - not storing anything');
      return 'failed';
    }
    /* v0.5.8 duplicate guard: the same group id, or any message id, already read
       under ANOTHER name this scan means the pane never changed. Reject. */
    const jidNow = paneJid();
    const ownerJ = jidNow ? scanJidOwner.get(jidNow) : null;
    if (ownerJ && normChatName(ownerJ) !== normChatName(name)) {
      log('REJECTED "' + name + '": the open chat has the same group id (' + jidTag(jidNow) + ') as "' + ownerJ + '" already read this scan - it is the same chat, nothing stored');
      return 'failed';
    }
    let dupN = 0, dupOwner = '';
    rr.messages.forEach((m) => { const o = scanIdOwner.get(m.id); if (o && normChatName(o) !== normChatName(name)) { dupN++; dupOwner = o; } });
    if (dupN > 0) {
      log('REJECTED "' + name + '": ' + dupN + ' of its ' + rr.messages.length + ' messages were already read under "' + dupOwner + '" this scan - same chat, nothing stored');
      return 'failed';
    }
    if (jidNow) scanJidOwner.set(jidNow, name);
    rr.messages.forEach((m) => { scanIdOwner.set(m.id, name); });
    const total0 = rr.messages.length;
    const cap = firstScan ? 500 : 150;
    const inWindow = rr.messages.slice(-cap).filter((m) => {
      const at = gpParseMsgTime(m.timeText);
      return !at || at >= windowStart; // never collect messages older than the window
    });
    const san = sanitizeMessages(inWindow);
    const msgs = san.msgs;
    lastReadCount = msgs.length;
    if (!msgs.length) {
      log('"' + name + '": 0 usable messages - ' + rr.note + ' (' + total0 + ' extracted, ' + (total0 - inWindow.length) +
        ' older than the ' + winDays + '-day window' + (san.dropped ? ', ' + san.dropped + ' sensitive dropped' : '') + ')');
      if (total0 > 0 && !inWindow.length) {
        // read fine, all history older than the window: mark it read so the
        // next scan does not re-open it for nothing
        const sig0 = (e.tsText || '') + '|' + (e.preview || '');
        await new Promise(r => mergeChatList({ [name]: Object.assign({}, e, { readSig: sig0, isGroup: true, verifiedGroup: true }) }, r));
      }
      return 'empty';
    }
    const added = await new Promise(r => sendBatches([{ group: name, messages: msgs }], r));
    const sig = (e.tsText || '') + '|' + (e.preview || '');
    const upd = Object.assign({}, e, { readSig: sig, isGroup: true, verifiedGroup: true });
    await new Promise(r => mergeChatList({ [name]: upd }, r));
    log('"' + name + '": ' + total0 + ' extracted' +
      (rr.historyRounds ? ' (scrolled back ' + rr.historyRounds + 'x' + (rr.reachedWindow ? ' to the ' + winDays + '-day edge' : ', no older history') + ')' : '') +
      ', ' + inWindow.length + ' in the window' + (san.dropped ? ', ' + san.dropped + ' sensitive dropped' : '') +
      ' -> stored ' + added + ' new' + (msgs.length - added > 0 ? ' (' + (msgs.length - added) + ' already stored)' : ''));
    if (chk.proof) log('"' + name + '" verified by ' + chk.proof + ' (header unreadable, group id ' + jidTag(jidNow) + ') - stored under its list name');
    lastReadCount = msgs.length;
    if (rr.note !== 'ok') log('WARNING reading "' + name + '": ' + rr.note);
    return 'stored';
  }

  /* v0.5.6: the fast path. A scan with a saved selection touches ONLY the
     selected groups: no Groups-filter toggling, no scrolling the whole chat
     list. Each selected group whose row is stale or shows new activity is
     opened through the search box, waited on, verified and read. Rows seen
     fresh (this harvest, or by the passive observer in the last 15 minutes)
     with an unchanged preview are provably quiet and skipped. */
  async function readSelectedGroups(ctx) {
    const { maxOpen, mutesAll, selected, windowStart, winDays, t0, origName, scroller, origScroll, listStamp } = ctx;
    const ageH = Math.round((Date.now() - listStamp) / 360000) / 10;
    log('scan: going straight to your ' + selected.size + ' selected group(s) - the full group list was built ' +
        (ageH < 1 ? 'under an hour' : 'about ' + ageH + 'h') + ' ago (it refreshes from the Groups picker, or by itself once a day)');
    progress({ phase: 'reading', found: selected.size, groups: [], current: '', done: 0, total: 0, pct: 5 }, true);
    // one cheap harvest of whatever happens to be on screen - no scrolling
    const h0 = harvestChatList();
    const freshRows = new Set(Object.keys(h0.found));
    await new Promise(r => mergeChatList(h0.found, r));
    const storeNow = (await chrome.storage.local.get(GP.STORE.CHATLIST))[GP.STORE.CHATLIST] || {};
    const now = Date.now();
    const todo = [];
    const gstat = {};   // v0.5.8: per-group outcome for the popup: {state:'read'|'quiet'|'failed', n, why}
    Array.from(selected).forEach((n) => {
      const e = storeNow[n];
      if (gpIsExcludedChat(n)) return;
      if (!e) { gstat[n] = { state: 'failed', why: 'not found in the chat list' }; return; }
      if (mutesAll.has(n)) { gstat[n] = { state: 'quiet', why: 'muted in GroupPing' }; return; }
      if (!e.isGroup) { gstat[n] = { state: 'failed', why: 'could not be confirmed as a group' }; return; }
      if (e.isCommunity) { gstat[n] = { state: 'community', why: 'a Community container - pick its subgroups instead' }; return; }
      if (e.muted && !e.mention) { gstat[n] = { state: 'quiet', why: 'muted in WhatsApp, no mention' }; return; }
      if (!e.lastTs || e.lastTs < windowStart) { gstat[n] = { state: 'quiet', why: 'no messages in the last ' + winDays + ' days' }; return; }
      const sig = (e.tsText || '') + '|' + (e.preview || '');
      const rowFresh = freshRows.has(n) || (now - (e.seenAt || 0) < 15 * 60000);
      if (rowFresh && e.readSig && e.readSig === sig && !(e.unread > 0)) { gstat[n] = { state: 'quiet', why: 'no new messages since the last scan' }; return; }
      todo.push({ n, e });
    });
    todo.sort((a, b) => (b.e.lastTs || 0) - (a.e.lastTs || 0));
    if (!todo.length) log('opening phase: no selected group shows new activity - nothing to open');
    else log('opening phase: ' + todo.length + ' of ' + selected.size + ' selected group(s) to check' + (todo.length > maxOpen ? ' - reading the ' + maxOpen + ' most recent' : ''));
    let openedCount = 0, failures = 0;
    const composeBefore = composeBoxText();
    for (let ti = 0; ti < todo.length && openedCount < maxOpen; ti++) {
      const name = todo[ti].n, e = todo[ti].e;
      progress({ phase: 'reading', found: selected.size, groups: [], current: name, done: openedCount,
        total: Math.min(todo.length, maxOpen), pct: 5 + Math.round(95 * ti / Math.max(1, Math.min(todo.length, maxOpen))) }, true);
      let ok = false;
      try { ok = await openGroupChat(name, e.aliases); } catch (er) { log('opening "' + name + '" threw: ' + (er && er.message)); ok = false; }
      if (!ok) {
        if (communityNames.has(name)) {
          gstat[name] = { state: 'community', why: 'a Community container - pick its subgroups instead' };
          await new Promise(r => mergeChatList({ [name]: Object.assign({}, e, { isCommunity: true }) }, r));
        } else { failures++; gstat[name] = { state: 'failed', why: 'could not open the chat' }; }
        log('could not open chat "' + name + '" by any method - skipped'); continue;
      }
      lastReadCount = 0;
      const outcome = await openReadStore(name, e, winDays, windowStart);
      if (outcome === 'stored') { openedCount++; gstat[name] = { state: 'read', n: lastReadCount }; }
      else if (outcome === 'empty') { gstat[name] = { state: 'quiet', why: 'no messages in the last ' + winDays + ' days' }; }
      else { failures++; gstat[name] = { state: 'failed', why: 'opened but could not be verified or read' }; }
      await sleep(250);
    }
    todo.slice(Math.min(todo.length, maxOpen)).forEach((t) => { if (!gstat[t.n]) gstat[t.n] = { state: 'failed', why: 'not reached - scan limit' }; });
    /* v0.5.8 FINAL RETRY PASS: every group that failed above gets one more go
       with a different method order and a clean search, before the scan may
       report "could not read". Groups with no row at all (not in the list) are
       not retried. */
    const retryNames = Object.keys(gstat).filter(n => gstat[n].state === 'failed' && storeNow[n] && storeNow[n].isGroup);
    if (retryNames.length) {
      log('retry pass: ' + retryNames.length + ' group(s) failed the first pass - trying again with a different method order: ' + retryNames.join(', '));
      for (let ri = 0; ri < retryNames.length; ri++) {
        const name = retryNames[ri], e = storeNow[name];
        progress({ phase: 'reading', found: selected.size, groups: [], current: name + ' (retry)', done: openedCount, total: todo.length, pct: 95 }, true);
        let ok = false;
        try { ok = await openGroupChatAlt(name, e.aliases); } catch (er) { log('retry opening "' + name + '" threw: ' + (er && er.message)); }
        if (!ok) { log('retry: still could not open "' + name + '"'); gstat[name] = { state: 'failed', why: 'could not open the chat (also after a retry)' }; continue; }
        lastReadCount = 0;
        const outcome = await openReadStore(name, e, winDays, windowStart);
        if (outcome === 'stored') { openedCount++; failures = Math.max(0, failures - 1); gstat[name] = { state: 'read', n: lastReadCount, retried: true }; log('retry: "' + name + '" read on the second try'); }
        else if (outcome === 'empty') { failures = Math.max(0, failures - 1); gstat[name] = { state: 'quiet', why: 'no messages in the last ' + winDays + ' days' }; }
        else gstat[name] = { state: 'failed', why: 'opened but could not be verified or read (also after a retry)' };
        await sleep(250);
      }
    }
    if (composeBefore !== null && composeBoxText() !== composeBefore) {
      log('NOTE: the message box content changed during this scan. GroupPing never types there - if you did not type it, send the Debug log to support.');
    }
    // put you back in the chat you had open
    if (openedCount && origName && !chatIsOpen(origName, null, { requirePositive: true }).open) {
      try { await openGroupChat(origName); } catch (e3) {}
    } else if (openedCount && !origName) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    }
    scroller.scrollTop = origScroll;
    progress({ phase: 'done', found: selected.size, groups: [], pct: 100, opened: openedCount }, true);
    log('read-all (selected groups only): opened ' + openedCount + ' of ' + todo.length + (failures ? ', ' + failures + ' failed' : '') +
        ', ' + Math.round((Date.now() - t0) / 1000) + 's');
    const gKeys = Object.keys(gstat);
    log('scan result: ' + gKeys.filter(n => gstat[n].state === 'community').length + ' community container(s), ' + gKeys.filter(n => gstat[n].state === 'read').length + ' read, ' + gKeys.filter(n => gstat[n].state === 'quiet').length +
        ' quiet, ' + gKeys.filter(n => gstat[n].state === 'failed').length + ' could not be read (of ' + selected.size + ' selected)' +
        (gKeys.filter(n => gstat[n].state === 'failed').length ? ' - failed: ' + gKeys.filter(n => gstat[n].state === 'failed').map(n => n + ' [' + gstat[n].why + ']').join('; ') : ''));
    return { ok: true, count: Object.keys(storeNow).length, groups: selected.size, opened: openedCount, failures, deep: true, selectedOnly: true, groupStatus: gstat };
  }

  /* The hourly read: harvest the full chat list (scrolling), and - if allowed -
     open each group with NEW activity so its messages can be read. Chats with
     nothing new are never opened. Puts you back in the chat you had open. */
  async function readAll(opts) {
    if (scanning) return { ok: true, running: true, note: 'A scan is already running - it will finish by itself.' };
    scanJidOwner.clear(); scanIdOwner.clear();
    let first = harvestChatList();
    if (!first.rowCount) {
      // right after a tab reload the list takes a few seconds - wait for it (v0.5.5)
      log('chat list not on screen yet - waiting for WhatsApp Web to finish loading');
      const pane0 = await waitForPane(12000);
      if (pane0) { await waitForRows(4000); first = harvestChatList(); }
    }
    if (!first.rowCount) {
      return { ok: false, error: 'chat list not found on screen. ' + first.diag + '. Is WhatsApp Web loaded and showing your chats?' };
    }
    const deep = !!(opts && opts.deepRead);
    const maxOpen = Math.max(0, Math.min(GP.MAX_DEEP_READ, (opts && opts.max) || GP.MAX_DEEP_READ));
    const pane = findChatListPane();
    const scroller = findScroller(pane) || pane;
    scanning = true;
    const t0 = Date.now();
    const origName = getOpenChatName().name;
    const origScroll = scroller.scrollTop;
    const mutesAll = new Set();
    let winDays = GP.DEFAULT_WINDOW_DAYS;
    let selected = new Set();
    try {
      const md = await chrome.storage.local.get([GP.STORE.MUTES, GP.STORE.SETTINGS, GP.STORE.SELGROUPS]);
      const mu = md[GP.STORE.MUTES] || {};
      Object.keys(mu).forEach((n) => { const m = gpMuteState(mu, n, Date.now()); if (m && m.mode === 'all') mutesAll.add(n); });
      winDays = Math.min(365, Math.max(1, parseInt((md[GP.STORE.SETTINGS] || {}).windowDays, 10) || GP.DEFAULT_WINDOW_DAYS));
      selected = gpSelectedGroups(md[GP.STORE.SELGROUPS]);
    } catch (e) {}
    const windowStart = t0 - winDays * 86400000;
    /* v0.5.6: with a saved selection AND a cached group list less than a day
       old, skip the full listing (no Groups-filter toggling, no scrolling
       through every chat) and go straight to the selected groups. The full
       listing runs again only from the Groups picker, or once the cached
       list is a day old, or when some selected group is not cached yet. */
    if (deep && selected.size) {
      const dl = await chrome.storage.local.get([GP.STORE.CHATLIST, GP.STORE.LISTSTAMP]);
      const cachedList = dl[GP.STORE.CHATLIST] || {};
      const listStamp = dl[GP.STORE.LISTSTAMP] || 0;
      const allCached = Array.from(selected).every(n => cachedList[n] && cachedList[n].isGroup === true);
      if (allCached && Date.now() - listStamp < 24 * 3600e3) {
        return await readSelectedGroups({ maxOpen, mutesAll, selected, windowStart, winDays, t0, origName, scroller, origScroll, listStamp });
      }
      log(!allCached ? 'some selected groups are not in the cached group list yet - running the full listing first'
                     : 'the cached group list is over a day old - refreshing the full listing first');
    }
    const toRead = new Map(); // groups with new activity, opened AFTER the listing (v0.5.5)
    let openedCount = 0, failures = 0, stuck = 0, lastTop = -1, oldScreens = 0;
    const groupsSeen = new Set(), recent = [];
    const knownBefore = new Set(Object.keys((await chrome.storage.local.get(GP.STORE.CHATLIST))[GP.STORE.CHATLIST] || {}));
    const reportedRejects = new Set();
    let filterOn = false;
    try {
      progress({ phase: 'listing', found: 0, groups: [], pct: 0 }, true);
      /* WhatsApp's own Groups filter makes the list groups-only, so the scan
         cannot mistake a direct chat for a group (v0.5.4). */
      filterOn = await setGroupsFilter(true);
      scroller.scrollTop = 0; await waitForRows(2500);
      for (let step = 0; step < 90 && stuck < 3; step++) {
        const h = harvestChatList();
        (h.rejected || []).forEach((rj) => { if (reportedRejects.size < 60 && !reportedRejects.has(rj)) { reportedRejects.add(rj); log('not a group: ' + rj); } });
        Object.keys(h.found).forEach((n) => { if (!knownBefore.has(n) && !groupsSeen.has(n)) log('group: "' + n + '" (' + (h.found[n].groupWhy || 'group signal') + ')'); });
        const entries = h.found;
        // remember rows first so isGroup/readSig state is merged
        await new Promise(r => mergeChatList(entries, r));
        const store = (await chrome.storage.local.get(GP.STORE.CHATLIST))[GP.STORE.CHATLIST] || {};
        Object.keys(entries).forEach((n) => {
          const e = store[n] || entries[n];
          if (e.isGroup && !groupsSeen.has(n)) { groupsSeen.add(n); recent.push(n); }
        });
        const max = scroller.scrollHeight - scroller.clientHeight;
        progress({ phase: 'listing', found: groupsSeen.size, groups: recent.slice(-6), pct: max > 0 ? Math.min(99, Math.round(100 * scroller.scrollTop / max)) : 100 });

        // The chat list is sorted newest-first: when two screens in a row have
        // no chat newer than the look-back window, everything below is older -
        // stop scrolling instead of walking back through years of chats.
        const stamps = Object.keys(entries).map(n => entries[n].lastTs).filter(Boolean);
        if (stamps.length && Math.max.apply(null, stamps) < windowStart) {
          oldScreens++;
          if (oldScreens >= 2) { log('chat-list scan stopped at the ' + winDays + '-day window (older chats below are ignored)'); break; }
        } else oldScreens = 0;

        // remember which groups need a real read; the opening itself happens
        // AFTER the listing, once the Groups filter is off (v0.5.5)
        if (deep) {
          Object.keys(entries).forEach((n) => {
            if (toRead.has(n)) return;
            const e = store[n] || entries[n];
            if (wantsRead(n, e, mutesAll, Date.now(), windowStart, selected)) toRead.set(n, e);
          });
        }
        if (scroller.scrollTop === lastTop) stuck++; else stuck = 0;
        lastTop = scroller.scrollTop;
        scroller.scrollTop += Math.max(200, Math.floor(scroller.clientHeight * 0.8));
        await waitForRows(1200); await sleep(250);
      }
      // one last pass over the very top - the first screen can render late
      scroller.scrollTop = 0; await waitForRows(2000);
      const topH = harvestChatList();
      (topH.rejected || []).forEach((rj) => { if (reportedRejects.size < 60 && !reportedRejects.has(rj)) { reportedRejects.add(rj); log('not a group: ' + rj); } });
      Object.keys(topH.found).forEach((n) => { if (!knownBefore.has(n) && !groupsSeen.has(n)) { groupsSeen.add(n); recent.push(n); log('group: "' + n + '" (' + (topH.found[n].groupWhy || 'group signal') + ')'); } });
      await new Promise(r => mergeChatList(topH.found, r));

      if (filterOn) { try { await chrome.storage.local.set({ [GP.STORE.LISTSTAMP]: Date.now() }); } catch (e4) {} }
      /* ---------- opening phase (v0.5.5) ----------
         Clicking rows inside the FILTERED, scrolling list missed every time
         on live WhatsApp (v0.5.4): the filter re-renders the list under the
         click and row nodes go stale. So the scan lists first, then the
         Groups filter goes OFF and each wanted group is opened by name -
         WhatsApp's own search box first, row-click as fallback - and every
         open is verified against the header with a forgiving name compare. */
      if (filterOn) { filterOn = false; await setGroupsFilter(false); }
      if (deep && toRead.size) {
        const dF = await chrome.storage.local.get(GP.STORE.CHATLIST);
        const storeF = dF[GP.STORE.CHATLIST] || {};
        const todo = [];
        toRead.forEach((e0, n) => {
          const e = storeF[n] || e0;
          if (wantsRead(n, e, mutesAll, Date.now(), windowStart, selected)) todo.push({ n, e });
        });
        log('opening phase: ' + todo.length + ' group(s) have new activity' + (todo.length > maxOpen ? ' - reading the ' + maxOpen + ' most recent' : ''));
        for (let ti = 0; ti < todo.length && openedCount < maxOpen; ti++) {
          const name = todo[ti].n, e = todo[ti].e;
          progress({ phase: 'reading', found: groupsSeen.size, groups: recent.slice(-6), current: name, done: openedCount, total: Math.min(todo.length, maxOpen), pct: 100 }, true);
          let ok = false;
          try { ok = await openGroupChat(name, e.aliases); } catch (er) { log('opening "' + name + '" threw: ' + (er && er.message)); ok = false; }
          if (!ok) { failures++; log('could not open chat "' + name + '" by any method - skipped'); continue; }
          const outcome = await openReadStore(name, e, winDays, windowStart);
          if (outcome === 'stored') openedCount++;
          else if (outcome === 'failed') failures++;
          await sleep(250);
        }
      }
      // put the user back in the chat they had open
      if (openedCount && origName && !chatIsOpen(origName, null, { requirePositive: true }).open) {
        try { await openGroupChat(origName); } catch (e3) {}
      } else if (openedCount && !origName) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      }
      if (!openedCount || origName === null) scroller.scrollTop = origScroll; else scroller.scrollTop = 0;
      const d2 = await chrome.storage.local.get(GP.STORE.CHATLIST);
      const total = Object.keys(d2[GP.STORE.CHATLIST] || {}).length;
      progress({ phase: 'done', found: groupsSeen.size, groups: recent.slice(-6), pct: 100, opened: openedCount, chats: total }, true);
      log('read-all: ' + total + ' chats known, ' + groupsSeen.size + ' groups, opened ' + openedCount + (deep ? '' : ' (opening chats is OFF in settings)') +
          (failures ? ', ' + failures + ' failed' : '') + ', ' + Math.round((Date.now() - t0) / 1000) + 's');
      return { ok: true, count: total, groups: groupsSeen.size, opened: openedCount, failures, deep };
    } catch (e) {
      log('read-all ERROR: ' + (e && e.message));
      progress({ phase: 'error', error: e && e.message }, true);
      return { ok: false, error: e && e.message };
    } finally {
      if (filterOn) { try { await setGroupsFilter(false); } catch (e2) {} }
      scanning = false;
    }
  }

  /* The group picker's own scan (v0.5.4): list EVERY group WhatsApp knows
     about, reading no message content. Uses WhatsApp's own "Groups" filter
     when the chip exists (then every listed row is certainly a group),
     scrolls the whole list down to 6 months back, waits for the virtualised
     list to render at every step, and logs every accepted group (with the
     signal that proved it) and every rejected row (with the reason). When the
     filter was on, anything stored earlier but NOT in WhatsApp's group list
     (a direct chat an older version misdetected, or a group inactive for
     6+ months) is removed from the stored list. */
  async function listAllGroups() {
    if (scanning) return { ok: false, error: 'a scan is already running' };
    scanning = true;
    const t0 = Date.now();
    const reportedRejects = new Set();
    const noteReject = (rj) => { if (reportedRejects.size < 80 && !reportedRejects.has(rj)) { reportedRejects.add(rj); log('not a group: ' + rj); } };
    let filterOn = false;
    try {
      progress({ phase: 'listing', found: 0, groups: [], pct: 0 }, true);
      filterOn = await setGroupsFilter(true);
      let pane = findChatListPane();
      if (!pane) { log('chat list not on screen yet - waiting for WhatsApp Web to finish loading'); pane = await waitForPane(12000); }
      if (!pane) return { ok: false, error: 'chat list not found on screen. Is WhatsApp Web loaded and showing your chats?' };
      const scroller = findScroller(pane) || pane;
      const origScroll = scroller.scrollTop;
      const sixMonthsAgo = Date.now() - 183 * 86400000;
      const groupsSeen = new Set(), recent = [];
      const take = async (h) => {
        (h.rejected || []).forEach(noteReject);
        Object.keys(h.found).forEach((n) => {
          if (!groupsSeen.has(n)) { groupsSeen.add(n); recent.push(n); log('group: "' + n + '" (' + (h.found[n].groupWhy || 'group signal') + ')'); }
        });
        await new Promise(r => mergeChatList(h.found, r));
      };
      let stuck = 0, lastTop = -1, oldScreens = 0;
      scroller.scrollTop = 0;
      await waitForRows(2500);
      for (let step = 0; step < 140 && stuck < 3; step++) {
        const h = harvestChatList();
        await take(h);
        const max = scroller.scrollHeight - scroller.clientHeight;
        progress({ phase: 'listing', found: groupsSeen.size, groups: recent.slice(-6), pct: max > 0 ? Math.min(99, Math.round(100 * scroller.scrollTop / max)) : 100 });
        const stamps = Object.keys(h.found).map(n => h.found[n].lastTs).filter(Boolean);
        if (stamps.length && Math.max.apply(null, stamps) < sixMonthsAgo) {
          oldScreens++;
          if (oldScreens >= 2) { log('group-list scan stopped 6 months back - groups older than that stay hidden'); break; }
        } else oldScreens = 0;
        if (scroller.scrollTop === lastTop) stuck++; else stuck = 0;
        lastTop = scroller.scrollTop;
        scroller.scrollTop += Math.max(200, Math.floor(scroller.clientHeight * 0.8));
        await waitForRows(1200); await sleep(250);
      }
      // final pass over the very top (the first screen can render late)
      scroller.scrollTop = 0;
      await waitForRows(2000);
      await take(harvestChatList());
      scroller.scrollTop = origScroll;
      let removed = [];
      if (filterOn) {
        // WhatsApp's own filter listed every group: anything else stored is
        // not a group (older misdetections) or long inactive - drop it.
        // v0.5.7: NEVER drop a SELECTED group - community subgroups often do
        // not show under WhatsApp's Groups filter, and purging them deleted
        // her selection from the cached list.
        const d3 = await chrome.storage.local.get([GP.STORE.CHATLIST, GP.STORE.SELGROUPS]);
        const store = d3[GP.STORE.CHATLIST] || {};
        const selNow = gpSelectedGroups(d3[GP.STORE.SELGROUPS]);
        let keptSelected = 0;
        Object.keys(store).forEach((n) => {
          if (!groupsSeen.has(n) && !store[n].notGroupAt) {
            if (selNow.has(n)) { keptSelected++; return; }
            removed.push(n); delete store[n];
          }
        });
        if (keptSelected) log('group-list scan: kept ' + keptSelected + ' selected group(s) WhatsApp\'s Groups filter did not list (community subgroups often hide from it)');
        if (removed.length) {
          await chrome.storage.local.set({ [GP.STORE.CHATLIST]: store });
          log('group-list scan: removed ' + removed.length + ' stored chat(s) that are NOT in WhatsApp\'s group list (' +
              removed.slice(0, 8).join(', ') + (removed.length > 8 ? ', ...' : '') + ')');
        }
      }
      const d2 = await chrome.storage.local.get(GP.STORE.CHATLIST);
      const total = Object.keys(d2[GP.STORE.CHATLIST] || {}).length;
      try { await chrome.storage.local.set({ [GP.STORE.LISTSTAMP]: Date.now() }); } catch (e5) {}
      progress({ phase: 'done', found: groupsSeen.size, groups: recent.slice(-6), pct: 100 }, true);
      log('group-list scan: ' + groupsSeen.size + ' groups listed (' + total + ' stored), ' +
          reportedRejects.size + ' non-group row(s) ignored' + (filterOn ? ' (WhatsApp Groups filter was on)' : ' (built-in signals only)') +
          ', ' + Math.round((Date.now() - t0) / 1000) + 's');
      return { ok: true, groups: groupsSeen.size, count: total, removed: removed.length };
    } catch (e) {
      log('group-list scan ERROR: ' + (e && e.message));
      progress({ phase: 'error', error: e && e.message }, true);
      return { ok: false, error: e && e.message };
    } finally {
      if (filterOn) { try { await setGroupsFilter(false); } catch (e2) {} }
      scanning = false;
    }
  }

  /* The search box above the chat list (never the message box in a chat). */
  function findSearchBox() {
    const sels = ['div[role="textbox"][data-tab="3"]',
      '#side div[contenteditable="true"][role="textbox"]',
      '#side div[contenteditable="true"]',
      '#side input[type="text"]',
      'div[aria-label*="search" i][contenteditable="true"]',
      'div[role="textbox"][aria-label*="search" i]',
      'input[aria-label*="search" i]',
      'input[title*="search" i]',
      '[data-testid="chat-list-search"]',
      'div[contenteditable="true"][data-tab]'];
    const visible = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 8; } catch (e) { return true; } };
    for (const s of sels) {
      const el = document.querySelector(s);
      // never anything inside the open chat (#main holds the message compose
      // box - typing there would be a disaster)
      if (el && !el.closest('#main') && visible(el)) return el;
    }
    // last resort: any editable textbox NOT inside the open chat
    const all = qsa(document, 'div[contenteditable="true"][role="textbox"], input[type="text"]');
    for (const el of all) { if (!el.closest('#main') && visible(el)) return el; }
    return null;
  }

  async function waitForSearchBox(maxMs) {
    const end = Date.now() + (maxMs || 3000);
    let box = findSearchBox();
    while (!box && Date.now() < end) { await sleep(250); box = findSearchBox(); }
    return box;
  }

  /* The message compose box in the open chat - GroupPing must NEVER change
     it. Read its content so a scan can prove it left it untouched. */
  function composeBoxText() {
    const b = document.querySelector('#main footer div[contenteditable="true"]') ||
      document.querySelector('#main div[contenteditable="true"][role="textbox"]');
    return b ? String(b.innerText || '') : null;
  }

  function searchText(box) {
    try {
      const v = (box.tagName === 'INPUT' || box.tagName === 'TEXTAREA') ? box.value : (box.innerText || box.textContent || '');
      return String(v || '').replace(/[\u200B-\u200D\uFEFF\n]/g, '').trim();
    } catch (e) { return ''; }
  }
  /* v0.5.8: FULLY clear the search box - select all + delete, WhatsApp's own
     clear (x) button, Escape - and wait until it is really empty. Her v0.5.7
     log showed the results of the previous query staying on screen. */
  /* v0.5.9: clear the box WITHOUT touching the open chat. v0.5.8 clicked the
     x button and sent Escape to the whole page - with the focus gone from the
     search box, Escape CLOSES the open chat, which is why TBM opened and then
     had "message panel missing". Now: select-all + delete inside the box, the
     x button only if text is still there, Escape only to the box itself. */
  async function clearSearch(box) {
    for (let i = 0; i < 3 && searchText(box); i++) {
      try {
        box.focus();
        document.execCommand('selectAll');
        document.execCommand('delete');
        if (searchText(box)) { box.textContent = ''; box.dispatchEvent(new InputEvent('input', { bubbles: true })); }
      } catch (e) {}
      if (searchText(box)) {
        const x = document.querySelector('#side [aria-label*="clear search" i], #side [data-icon="x-alt"]');
        if (x) { try { (x.closest('button,[role="button"]') || x).click(); } catch (e) {} }
      }
      if (searchText(box)) {
        try { box.focus(); box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: false })); } catch (e) {}
      }
      await sleep(150);
    }
    await sleep(200);
    return !searchText(box);
  }
  async function typeSearch(box, text) {
    try { box.focus(); box.click(); } catch (e) {}
    await sleep(120);
    let ok = false;
    try { document.execCommand('selectAll'); ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    if (!ok || normChatName(searchText(box)) !== normChatName(text)) {
      try { box.textContent = text; box.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' })); } catch (e) {}
    }
    return normChatName(searchText(box)) === normChatName(text);
  }
  function looseQuery(name) {
    return String(name || '').normalize('NFKC').replace(/[\p{Extended_Pictographic}\u200B-\u200D\uFE0F]/gu, ' ').replace(/\s+/g, ' ').trim();
  }
  function shortQuery(q) {
    if (q.length <= 14) return q;
    const cut = q.slice(0, 14);
    const sp = cut.lastIndexOf(' ');
    return (sp >= 6 ? cut.slice(0, sp) : cut).trim();
  }

  /* Open a chat by name through WhatsApp's own search box. v0.5.8: the box is
     cleared fully BEFORE every query, the query has emoji stripped (matching is
     emoji-insensitive), results are awaited until a row carrying the new name
     shows up (stale rows of the last query never match), and one retry uses a
     short distinctive prefix. Only a row that carries the exact name is
     clicked. */
  async function searchAndOpen(name, aliases) {
    const composeBefore = composeBoxText();
    const box = await waitForSearchBox(2500);
    if (!box) { log('search method: no search box found on the page (tried 10 selector shapes)'); return { ok: false }; }
    if (box.closest('#main')) { log('search method: REFUSED to type - the only editable box is the message box of the open chat'); return { ok: false }; }
    const full = looseQuery(name) || name;
    const queries = [full];
    const sq = shortQuery(full);
    if (sq && sq !== full) queries.push(sq);
    if (name !== full && queries.indexOf(name) === -1) queries.push(name);   // v0.5.9: last resort - the raw name, emoji and all
    let rows = [];
    for (let qi = 0; qi < queries.length && !rows.length; qi++) {
      const cleared = await clearSearch(box);
      if (!cleared) log('search method: could not fully clear the search box before "' + queries[qi] + '"');
      const typedOk = await typeSearch(box, queries[qi]);
      log('search method: typed "' + queries[qi] + '" into the WhatsApp search box' + (typedOk ? '' : ' (box text does not match - retrying differently)'));
      if (composeBefore !== null && composeBoxText() !== composeBefore) {
        log('WARNING: the message box content changed while the search box was used - GroupPing never types there. Tell support if you did not type it.');
      }
      await waitFor(() => { rows = findRowsForName(name); return rows.length > 0; }, qi ? 3000 : 3200, 180);
      if (!rows.length) {
        const r = findChatRows(findChatListPane());
        const names = r.rows.slice(0, 4).map(x => chatRowName(x).name).filter(Boolean);
        log('search method: "' + name + '" did not appear for query "' + queries[qi] + '"' + (names.length ? ' (results showed: ' + names.join(' | ') + ')' : ' (no result rows rendered)'));
      }
    }
    for (let ri = 0; ri < Math.min(rows.length, 2); ri++) {
      const ok = await tryOpenByClick(name, rows[ri], aliases);
      if (ok) { await clearSearch(box); return { ok: true }; }
      if (communityNames.has(name)) { await clearSearch(box); return { ok: false, community: true }; }
    }
    // keyboard: Enter only when the TOP result carries this chat's exact name
    const topRow = findChatRows(findChatListPane()).rows[0];
    if (topRow && normChatName(chatRowName(topRow).name) === normChatName(name)) {
      const ctx = { beforeJid: paneJid(), beforeSig: paneSignature(), prevName: getOpenChatName().name };
      try {
        box.focus();
        ['keydown', 'keypress', 'keyup'].forEach(t => box.dispatchEvent(
          new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true })));
      } catch (e) {}
      const st = await waitForOpen(name, 1800, aliases, ctx);
      if (st.open) { log('opened chat "' + name + '" with Enter on the search results - ' + st.diag); await clearSearch(box); return { ok: true }; }
      log('search method: Enter on the top result did not open it (' + st.diag + ')');
    }
    await clearSearch(box);
    return { ok: false };
  }

  /* Open a chat by name, trying every method with per-method logging:
     1) it is already open - nothing to do
     2) WhatsApp's own search box (most reliable: no stale rows, no scrolling)
     3) find its row in the chat list (scrolling) and click it, with the
        keyboard Enter variant
     Returns true only when the header positively shows this chat. */
  async function openGroupChat(name, aliases) {
    const already = chatIsOpen(name, aliases, { requirePositive: true });
    if (already.open) { log('"' + name + '" is already open (' + already.diag + ') - no click needed'); return true; }

    const viaSearch = await searchAndOpen(name, aliases);
    if (viaSearch.ok) return true;
    if (viaSearch.community || communityNames.has(name)) return false;

    const pane = await waitForPane(8000);
    if (!pane) { log('opening "' + name + '": chat list pane not found on screen'); return false; }
    const scroller = findScroller(pane) || pane;
    let rows = findRowsForName(name);
    if (!rows.length) {
      const row = await findRowByName(name, scroller);
      if (row) rows = [row];
    }
    if (!rows.length) { log('opening "' + name + '": its row was not found in the chat list either'); return false; }
    for (let ri = 0; ri < Math.min(rows.length, 1); ri++) {
      if (await tryOpenByClick(name, rows[ri], aliases)) return true;
    }
    return false;
  }

  /* v0.5.8 final-retry opener: DIFFERENT order from the normal pass. Clear the
     search, scroll the chat list back to the top, find the row by scrolling
     the list and click it; only then fall back to a fresh search. */
  async function openGroupChatAlt(name, aliases) {
    const ok0 = chatIsOpen(name, aliases, { requirePositive: true });
    const box = findSearchBox();
    if (box) { try { await clearSearch(box); } catch (e) {} }
    await sleep(600);
    const pane = await waitForPane(5000);
    if (pane) {
      const scroller = findScroller(pane) || pane;
      try { scroller.scrollTop = 0; } catch (e) {}
      await sleep(500);
      let rows = findRowsForName(name);
      if (!rows.length) { const row = await findRowByName(name, scroller); if (row) rows = [row]; }
      for (let ri = 0; ri < Math.min(rows.length, 2); ri++) {
        if (await tryOpenByClick(name, rows[ri], aliases)) return true;
        if (communityNames.has(name)) return false;
      }
      log('retry: row for "' + name + '" ' + (rows.length ? 'found but did not open' : 'not found by scrolling the list') + ' - trying a fresh search');
    }
    if (ok0.open) return true;
    const r = await searchAndOpen(name, aliases);
    return !!r.ok;
  }

  async function openChatByName(name) {
    if (scanning) return { ok: false, error: 'busy scanning' };
    const ok = await openGroupChat(name);
    return { ok };
  }

  /* ---------- self-test (Settings > General) ----------
     One click dumps what every selector ACTUALLY sees on this WhatsApp
     layout, so a breakage is diagnosable from the Debug log alone. Structure
     and counts only - NEVER message text, and digits are masked (phone
     numbers live inside data-ids). */
  function shapeOf(el, depth) {
    if (!el || depth > 4) return '';
    const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '')
      .split(/\s+/).filter(c => /message|copyable|selectable|text|meta|header|title|pane|main|list|row|grid/i.test(c)).slice(0, 3).join('.');
    let out = '<' + el.tagName.toLowerCase() + (cls ? '.' + cls : '') + '>';
    Array.from(el.children || []).slice(0, 2).forEach(k => { out += shapeOf(k, depth + 1); });
    return out;
  }
  async function selfTest() {
    const lines = [];
    const say = (t) => { lines.push(t); log('self-test: ' + t); };
    say('GroupPing v' + GP_V + ' self-test (structure only, no message text)');
    const panel = findMainPanel();
    say('message panel #main: ' + (panel ? 'found' : 'NOT FOUND'));
    const hdr = document.querySelector('#main header');
    say('chat header: ' + (hdr ? 'found' : 'not found (no chat open)'));
    const h = getOpenChatName();
    say('open-chat name read: ' + (h.name ? 'ok ("' + h.name + '")' : 'unreadable - ' + h.diag));
    const an = activeRowNames();
    say('highlighted chat-list row: ' + (an.length ? an.slice(0, 2).map(x => '"' + x.slice(0, 40) + '"').join(' / ') : 'none readable'));
    if (h.name && an.length) say('header name vs highlighted row: ' + (an.indexOf(normChatName(h.name)) !== -1 ? 'MATCH' : 'DIFFERENT (header "' + h.name + '")'));
    say('open chat group id: ' + jidTag(paneJid()));
    const pane = findChatListPane();
    say('chat list pane: ' + (pane ? 'found' : 'NOT FOUND'));
    if (pane) {
      const rr = findChatRows(pane);
      say('chat rows: ' + rr.rows.length + ' via ' + rr.strategy + ' (' + Object.keys(rr.counts).map(k => k + '=' + rr.counts[k]).join(', ') + ')');
    }
    say('search box: ' + (findSearchBox() ? 'found' : 'NOT FOUND'));
    say('message compose box: ' + (composeBoxText() !== null ? 'present (untouched)' : 'none open'));
    if (panel) {
      const r = findMessageNodes(panel);
      say('message nodes in open chat: ' + r.nodes.length + ' via ' + r.strategy + ' (' + Object.keys(r.counts).map(k => k + '=' + r.counts[k]).join(', ') + ')');
      const ex = extractOpenChatMessages();
      say('readable text messages extracted from the open chat: ' + ex.messages.length + ' (' + ex.note + ')');
      const gst = openChatGroupStatus();
      say('open chat group check: ' + (gst === true ? 'a group' : gst === false ? 'NOT a group' : 'cannot tell'));
      if (r.nodes.length) say('first message node shape (no text): ' + shapeOf(r.nodes[0], 0).slice(0, 220));
      const did = qsa(panel, '[data-id]')[0];
      if (did) say('first data-id shape (digits masked): ' + String(did.getAttribute('data-id') || '').replace(/\d/g, '#').slice(0, 70));
    } else {
      say('open a chat, then run the self-test again to check message reading');
    }
    say('self-test done - if anything above says NOT FOUND or 0 where it should not, send this log to support');
    return { ok: true, lines };
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'gp-ping') { sendResponse({ ok: true, v: GP_V }); return false; }
    if (msg.type === 'gp-read-all') { readAll(msg).then(sendResponse); return true; }
    if (msg.type === 'gp-scan-list') { readAll({ deepRead: false }).then(sendResponse); return true; }
    if (msg.type === 'gp-list-groups') { listAllGroups().then(sendResponse); return true; }
    if (msg.type === 'gp-open-chat') { openChatByName(msg.name).then(sendResponse); return true; }
    if (msg.type === 'gp-selftest') { selfTest().then(sendResponse); return true; }
    if (msg.type === 'gp-collect-now') {
      collect('on-demand collect', (diag) => sendResponse({ ok: true, diag: diag || lastDiag || null }));
      return true;
    }
    return false;
  });

  /* Cheap activity detection: the observer only sets a timer; at most one
     collect per 30 s, and none while a scan is running or the tab is hidden. */
  let timer = null, lastCollect = 0;
  function scheduleCollect() {
    if (timer) return;
    const wait = Math.max(3000, 30000 - (Date.now() - lastCollect));
    timer = setTimeout(() => {
      timer = null;
      if (document.hidden || scanning) return;
      lastCollect = Date.now();
      collect('new activity');
    }, wait);
  }
  let observer = null;
  function attachObserver() {
    const target = document.querySelector('#app') || document.body;
    observer = new MutationObserver((muts) => {
      for (const m of muts) { if (m.addedNodes && m.addedNodes.length) { scheduleCollect(); break; } }
    });
    observer.observe(target, { childList: true, subtree: true });
  }

  function start() {
    if (!document.body) { setTimeout(start, 1000); return; }
    attachObserver();
    setTimeout(() => collect('startup'), 3000);
    setInterval(() => { if (!document.hidden) collect('10-min poll'); }, 10 * 60 * 1000);
    log('GroupPing content script v' + chrome.runtime.getManifest().version + ' started on WhatsApp Web');
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) start();
  } // end guarded runtime hooks

  /* Node test hook (the extension never reaches this branch in Chrome). */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseChatRow, harvestChatList, mergeChatList, openChatGroupStatus, sanitizeMessages,
      wantsRead, getOpenChatName, extractOneMessage, extractOpenChatMessages, findChatRows, clickCandidates,
      tryOpenByClick, openChatByName, openGroupChatAlt, collect, BAD_HEADER_NAME, chatRowName, listAllGroups,
      normChatName, chatIsOpen, waitForOpen, waitForPane, rowByNameNorm, searchAndOpen, openGroupChat, readAll,
      findSearchBox, findChatListPane, findRowByName, rowsByName, waitForMessages, readSelectedGroups,
      cleanHeaderText, badHeaderText, composeBoxText, waitForSearchBox,
      paneSignature, rowNameCandidates, findRowsForName, readGroupHistory, openReadStore, selfTest, shapeOf };
  }
})();
