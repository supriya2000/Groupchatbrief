# GroupPing v0.5.10 - Never miss anything in your group chats

Chrome extension for WhatsApp Web. Your own free Gemini key. Everything is stored in your browser.

## Install / update
1. Unzip groupping.zip (replace the old folder contents).
2. Chrome > chrome://extensions > Developer mode on > Load unpacked (or press Reload on GroupPing).
3. Click the GroupPing icon. If it says "Not reading WhatsApp yet", press "Fix it & scan now" - it reloads the WhatsApp tab for you (one time, after install/update).
4. Paste your Gemini key if asked > Connect Now. The first scan starts by itself within about 30 seconds.

## What it does
- Scans your group list, opens groups that have NEW activity (optional, can be turned off), reads new messages.
- Every hour (Settings: 1h or 3h) plus a final scan each evening.
- Only never-before-analysed messages go to Gemini, in one batched call. Chats with only chatter get just a short summary in the same call, so they cost almost nothing.
- Dashboard tabs: Today, Upcoming, Pending (needs your reply, High/Medium/Low), Muted.
- Add to calendar opens a prefilled Google Calendar event. Reminder 1 hour before (setting).
- Evening summary of everything across your groups.
- Mute a group: forever, 30 days, or until you unmute (mentions allowed).
- Free after the 14-day trial: 3 groups, no calendar, no reply reminders. Pro (license key GP-...) unlocks all.

## New in 0.5.10 (communities, settle-then-judge, groups without a group id)

- Communities: a Community container (e.g. "MU Unofficial 2026-27") opens its Announcements group, not a chat of its own. Ticking one now selects its subgroups instead (found through the community label on their chat-list rows), and a community ticked earlier is swapped for its subgroups before the next scan. The picker marks communities. If no subgroups are known, the Scan report says "Community - pick its subgroups" instead of "could not read".
- Settle, then judge: after a click or Enter the page is watched for up to 3.5s. A "wrong chat" verdict must hold steady for 1.2s before it is believed, so a correct open is never called wrong during the header/pane swap.
- Chats whose messages carry no group id (so they cannot be proven a group from messages) are read when the header positively shows the group's name AND the chat list already proved it a group. A direct-chat id still stops the read. The log prints the masked id structure for diagnosis.
- Search Enter only when the TOP result's main name equals the group name (a message preview no longer counts).

## New in 0.5.9 (opening chats again + final retry)

- FIXED a regression in 0.5.8: chats stopped opening. The method that works on live WhatsApp (Enter on the row's inner div[tabindex], and Enter on the search result) is back. Order: click the name cell, Enter on the inner div[tabindex], Enter on the cell, click the row. The wrong-chat guards stay: a chat counts as open only if the header or highlighted row shows its name, or the pane switched to a new group id not used by another group this scan.
- FIXED: clearing the search box sent Escape to the whole page, which CLOSES the open chat (the "message panel missing" after a good open). Now the box is cleared inside itself and the open chat is never touched.
- Search Enter is only used when the top result's TITLE equals the group name (a message preview that happened to say "Jobs" no longer counts). One more query form (the raw name with emoji) is tried last.
- FINAL RETRY PASS: any selected group that failed gets one more try with a different order (clear search, scroll the chat list to the top, find the row by scrolling, click or Enter it, then a fresh search). Still-failed groups show "Could not read (also after a retry)".

## New in 0.5.8 (wrong-group summaries, search that stuck, honest scan report)

- FIXED the serious one: the same messages were stored under three group names. The scan treated "already open" as true when it could not read the chat header, and a click that changed nothing was accepted. Now a group counts as open only when (a) the header or the highlighted chat-list row positively shows its name, or (b) the message pane switched to a NEW group id (every WhatsApp group has its own id inside its messages) that no other group has already used this scan. A pane that did not change is never accepted.
- Duplicate guard: if messages read from a chat were already read under another group name, they are rejected and the Debug log says so. The background also refuses such a batch.
- On update, anything v0.5.7 stored under several names is cleared (messages, summaries, items) and re-read on the next scan, so no wrong summary is shown.
- Search box: fully cleared between groups, waits for the results to match the new query, strips emoji ("Events", not "Events"+emoji), retries once with a short prefix.
- Header name reader has a second method for headers that only show "click here for group info".
- Faster: at most 2 click targets per group, no pile of dead retries.
- Scan report in the popup: "Scanned X of Y groups", which had no new messages, which could not be read, and a per-group list. A group that could not be read shows "could not read", never an old or duplicate summary.
- "A scan is already running" is no longer an error; the popup shows live progress.
- Self-test also compares the header name with the highlighted chat-list row.

## New in 0.5.7 (groups that opened but read 0 messages + community groups)

- FIXED the big one: chats that "opened, verified" but stored 0 messages. The
  old check could accept the PREVIOUS chat's messages as proof while the pane
  was still swapping, then read before the new chat rendered. A group now
  counts as open only after the message pane actually changes, and messages
  are read only once they have rendered (up to 9s, retried next scan).
- FIXED: community subgroups (groups inside a Community, e.g. "MU Section B"
  under "MU Unofficial 2026-27"). Search results show the community label on
  the big line and the group name under it; GroupPing now matches the
  group-name line, clicks the right row, and refuses the community /
  "Announcements" chat instead of giving up.
- FIXED: the Debug log itself. Lines written in the same second raced and
  silently disappeared - whole scan phases were missing from v0.5.6 logs.
  Logging is now queued; nothing is lost.
- First scan of a group now SCROLLS BACK and collects everything inside your
  look-back window (default 30 days), not only what is on screen.
- Every group logs its full accounting: messages extracted / inside the
  window / sensitive dropped / stored new / already stored.
- Faster: the click target that works on current WhatsApp is tried first
  (~3-5s per group when nothing goes wrong), dead-end fallbacks are capped.
- New: Settings > General > Run self-test dumps what every reader sees on
  your WhatsApp page (structure and counts only - never message text) into
  the Debug log, so any future breakage is diagnosable in one paste.
- The group picker no longer drops a SELECTED group just because WhatsApp's
  Groups filter did not list it (community subgroups often hide from it).

## New in 0.5.6 (fast selected-group scans + summaries for every group)
- Scans are fast now: once you have picked your groups, a scan goes STRAIGHT to them - no more scrolling through your whole chat list or toggling the Groups filter. The full group list is reused for a day; it rebuilds when you open the Groups picker (or by itself once a day, or if a selected group is missing from it).
- Fixed: "chats open but 0 read / could not verify". The check that confirms the right chat is open was reading the wrong part of the header (the member list, an icon label, or the "click here for group info" hint) and rejecting good chats. It now picks the actual title (largest, topmost header text), ignores those lookalikes even when they carry invisible characters, and waits for the chat pane to settle instead of reading it mid-switch.
- Community groups work: a group under a community shows the community name in its header - that now counts as a match against the chat-list label. And when the header cannot be read at all, GroupPing accepts the chat only if its messages prove it is a group (@g.us), and re-checks before storing a single message.
- Every selected group gets a summary: chats with no plans or questions used to be skipped without a Gemini call. They are now summarised too (Discussed / Plan / Decision), in the same batched call, trimmed so they barely cost anything. Groups with nothing actionable show "Nothing here needs action."
- The Today tab always shows Your action plan - and when it is empty it says why in plain words (no key, no new messages, scan still running, or simply "nothing needs action yet").
- The popup shows per-group progress while scanning ("Reading Stats ODC Group 9 (2/14 done)").
- Compose-box guard: GroupPing never types in a chat's message box. The scan now checks the box before and after, and the Debug log warns if its content ever changes during a scan.
- Better failure notes: "0 usable messages" now says exactly why (how many were extracted, how many were older than your look-back window, how many were dropped as sensitive), and the search-box finder tries more shapes of the WhatsApp search box before giving up.

## New in 0.5.5 (opening chats actually works)
- Fixed: "0 opened, 12 failed to open" - clicks inside WhatsApp's filtered, scrolling group list were missing every time. The scan now works in two phases: it lists your groups first, switches the Groups filter OFF, and only then opens the ones with new activity.
- New opening method, tried first: your group's name goes into WhatsApp's own search box and the matching result is used. No scrolling, no stale rows. Only a result whose name matches exactly is clicked, and the Enter shortcut is pressed only when the top result IS your group - a wrong chat is never opened.
- Every click is verified against the open chat's header with a forgiving name compare (different invisible spaces/characters no longer cause a false "failed"), and when an open fails the Debug log says what the header ACTUALLY showed instead of just "header did not change".
- Fallbacks kept: clicking the row in the list (now with the keyboard Enter variant) if the search box fails.
- Right after a tab reload GroupPing waits for the chat list to appear instead of giving up with "chat list pane not found".

## New in 0.5.4 (strict groups + the picker scans itself)
- Fixed: "Choose your groups" showed only a few groups. The picker now runs its own scan the moment it opens (live "Scanning your groups..." progress, then the full list, most active first, plus a Rescan button). It scrolls the WHOLE chat list down to 6 months back and waits for WhatsApp to render at every step - the first screen no longer gets skipped.
- Fixed: community groups (the ones with the community name above the group name) were read under the wrong name or not at all. GroupPing now picks the right name from the row.
- Strict groups-only, enforced harder: a chat is a group ONLY with positive proof - WhatsApp's own "Groups" filter (used during scans when your WhatsApp has it), a group icon/avatar, an @-mention badge, a "~Sender:" preview prefix, or an open chat whose messages carry group IDs. Plain message text that happens to start with "Word:" (like "PS:" or "Happy Birthday:") no longer fools it, and anything ambiguous is left out. The Debug log lists every accepted group with the signal that proved it, and every skipped chat with the reason.
- Chats proven NOT to be groups (a direct chat an older version mis-listed, e.g. a saved contact with a label like "Name(Team)") are removed from the group list and never come back - a rescan with WhatsApp's Groups filter also wipes any that slipped through.
- Even if you tick a non-group by mistake it is never read: before reading, GroupPing re-verifies the open chat from its message IDs (@g.us = group, @c.us/@lid = direct). "Cannot verify" now means "not read" (previously it read anyway), and the background refuses to store anything not positively known to be a group.

## New in 0.5.3 (privacy update)
- Groups only, as a hard rule. Direct (1-to-1) chats are never opened, read, stored or shown - not even their last-message preview. A chat GroupPing cannot positively identify as a group is skipped. Unsaved numbers and broadcast lists are never read.
- You pick the groups. Nothing is read until you switch a group on (popup onboarding or Settings > Groups, with search, select all/none, and groups quiet for 6+ months hidden). The Free plan limit (3 groups) applies to the ones you pick.
- Sensitive-content guard: OTPs, bank/card alerts and passwords are dropped whole before storing; codes, card/account/Aadhaar/PAN numbers, phone numbers, emails and payment links inside other messages are masked (<code>, <phone number>) before storing AND before anything goes to Gemini. Data stored by older versions is cleaned on first run.
- Settings > Privacy page: plainly what is read, what is stored (only in your browser), what is sent to Gemini and when - plus one-click "Delete all my GroupPing data" and Local-only mode (no Gemini calls at all; reply reminders still work).
- Note on free Gemini keys: Google may use free-tier API content to improve its products. A paid key is not used for training.
- New dashboard: an action plan (what to do, by when), a "Most active" strip, and per-group cards - Discussed / Plan / Decision on top, every plan, deadline, decision and question listed under its group.
- Reply reminders use only chat names, times and unread counts.

## New in 0.5.2
- Fixed: opening chats works again (the "header did not change" bug). GroupPing now tries each clickable element of the row until the chat actually opens, and the Reply button falls back to typing the chat name in the WhatsApp search box.
- Look-back window: GroupPing now only looks at the last 30 days (Settings > General > "How far back to look": 7/14/30/60/90 days). The chat-list scroll stops as soon as it reaches older chats, old chats are never opened or read, their messages never go to Gemini, and old stored data is deleted automatically.
- Reply reminders skip junk: broken "message couldn't load" previews, payment-link messages, job boards and promo channels. High priority is now rare (pinned people, @mentions, or truly urgent).
- Better plan extraction: the AI is told to report only concrete events/deadlines/decisions with who, when and what is confirmed vs still pending.
- The popup scan line is honest: "N groups found, M opened, K failed to open" instead of claiming all were read.
- Note: removing and re-adding the extension wipes saved settings. After a reinstall, paste your Gemini key again.

## New in 0.5.1
- First scan starts by itself after install/update/browser start (no button needed).
- If the WhatsApp tab has no GroupPing script (happens after updates), the scan reloads the tab and fixes it by itself.
- The popup shows a clear status: connected/scanning/last scan time/what went wrong.
- The content script logs its startup, so the Debug log always shows whether it is in the page.

## Limits (honest)
- Works only while Chrome is running and WhatsApp Web is open and logged in.
- WhatsApp changes its page often; if reading breaks, Settings > General > Debug log says which part stopped matching.
- Opening chats marks them read. Turn off in Settings > General if you do not want that.
