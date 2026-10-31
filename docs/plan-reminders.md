# Timed reminders — plan

Working plan for the feature designed on 2026-10-31: a reminder that knows *when*
("tomorrow 17:00"), warns before it, counts down in the closed island, and
chimes when it is due. Fold this into [product-spec.md](product-spec.md) when it
ships, and delete this file.

Baseline: the fork after the v1.5.1 merge (`531a14b`). See
[fork.md](fork.md) for what is ours and what is upstream's.

## Scope

In: one list with a due time; setting it from a line, the command surface or
the assistant; a quiet heads-up before; the closed island's countdown; the
chime, Done and Snooze; the reminders-page polish.

Out: recurrence ("every Monday"), per-reminder sounds, reminders inside the
calendar's month grid, a full date-picker widget (typing covers it), and water
reminders (removed upstream on purpose).

## Decisions

1. **One list.** Timed reminders live in `todo` (`TodoItem.due_ms`), not in the
   separate `Reminders1` store that only the assistant could reach. The page,
   the watcher, the assistant and the command surface then all see the same
   rows. `Reminders1` goes, with its `reminders.json` migrated once.
2. **The line sets the time.** `Call the bank tomorrow 17:00` is parsed by the
   daemon, the way `Calendar1.Parse` already reads `Dinner 8:00 pm`; the page
   shows the result as a chip. Day words join the time-of-day parser:
   `today`, `tomorrow`, `monday`…`sunday`, `on 3 Nov`, `in 10 min`, `in 2h`.
   A time already past today means tomorrow.
3. **One clock, the calendar's shape.** The reminder watcher learns the calendar
   page's idiom: the soonest deadline, nap-capped waits, a lead and a due fire,
   running while the page is closed. It does not hang off the calendar page:
   that loop's horizon is today-and-tomorrow and its state is occurrences.
4. **The warning is quiet, the hour is not.** Lead alert: no chime, not sticky.
   Due alert: sticky, chime, **Done** (ticks it off) and **Snooze 10 min**.
5. **Late is a state.** A reminder whose time passed stays at the top of the
   page saying how late it is; it is not silently dropped and not re-alarmed.

## Phases

### 0 — The when-parser and the one list

**Done** (`003f3e6`): `when.rs` with its tests, `TodoItem.due_ms`/`alerted`, `Todo1`'s
`Add(text, due_ms)`/`SetDue`/`SetAlerted`/`Parse`, `reminders.json` folded into `todo.json`,
`Reminders1` gone, the assistant's `remind` sending `when`.

- `crates/isle-core/src/when.rs`: `when(line) -> {title, due_ms}` on top of
  `calendar::parse`'s time of day, plus the day words above. Unit tests for
  each form, the past-means-tomorrow rule, and a line with no time.
- `TodoItem.due_ms: Option<i64>`, `TodoList::set_due`, and due times kept when
  a row is renamed.
- `Todo1`: `Add(s title, t due_ms)`, `SetDue(t id, t due_ms)`,
  `Parse(s line) -> s` (`{title, due_ms}`), `Items` carries `due_ms`.
- `Reminders1` removed; `reminders.json` read once and folded into `todo.json`;
  `MAX_DELAY_MS` (a week) becomes a year.
- Voice: the assistant's `remind` action sends `{when, text}`; `voice.js` calls
  `Todo1.Parse` then `Add`. `cancel_reminder` dismisses a todo id.

Done when: `cargo test -p isle-core` covers the parser, a migrated
`reminders.json` shows in the page, and the assistant can set "tomorrow 9am".

### 1 — Setting it on the page

**Done**: the new row reads the line 150 ms after typing stops (and again on Enter, in case it was faster),
shows the time it found as a chip; rows show their time at the right and clicking it edits it through the
same parser; the list is ordered late → soonest → untimed; a new row is scrolled to.

- The New reminder row parses as you type (`Todo1.Parse`, debounced) and shows
  the chip (`Tomorrow 17:00`; nothing for a line with no time); Enter adds with it.
- Rows show their time at the right; clicking it re-opens the chip to change it
  (`SetDue`).
- Order: late first, then soonest, then untimed in the order added — one
  comparator in `_update()`.
- After adding, scroll to the new row (not to the bottom).

Done when: a reminder typed with a time lands in the right place and survives a
restart.

### 2 — The warning and the hour

- Setting `reminder-alert-minutes` (0–60, 10 by default) and its row in
  Settings → Alerts, beside the event one.
- `reminders.js`: two fires per row (due − lead, due), the calendar's shape.
- `alerts.js`: a quiet lead alert (`Call the bank in 10 min`, 6 s, no sound, no
  button) and the due alert with **Done** and **Snooze 10 min**; the existing
  chime stays, with a "repeat until dismissed" option (off by default).
- Do Not Disturb keeps letting reminders through, as it does now.

Done when: with the lead at 10, a reminder shows twice, once quietly, once with
the chime, and Snooze moves it ten minutes on.

### 3 — Getting closer in the closed island

- A bell sign and its countdown take the right slot within the lead window:
  `9m` in white, `45s` in the page's orange for the last minute.
- `compact.js`: `reminder` joins the activities after the timer; the countdown
  gets the timer time's width rules (`_fit`, `TEXT_INSET`); a warning (service
  down, muted call, assistant at work) still wins the slot.

Done when: a reminder ten minutes out shows beside the clock and disappears when
it is dismissed, without moving the clock.

### 4 — The page's polish

- The right slot belongs to the time; ▶ and × take it under the pointer (and
  when the row has focus), so no width is reserved and nothing reflows.
- A wrapped title is struck on every line (`wrapLines`' `Pango.AttrList` gains
  a strikethrough attribute; the animated widget stays for one line).
- Keyboard: ↑/↓ between rows, Space ticks, Enter renames, Delete removes.
- A failed add keeps the typed text and says why (isled down).
- The empty state teaches: "Type above, or press Super+K".

Done when: the page can be used without the pointer, and a mis-ticked row is
recoverable.

### 5 — Docs and proof

- `docs/product-spec.md`: the page, the alert table (lead and due), the closed
  island's reminder sign.
- `docs/dbus-api.md`: `Todo1`'s new members, `Reminders1` gone.
- `CHANGELOG.md` under `[Unreleased]`; README's reminders bullet; `docs/fork.md`
  gains the new key and D-Bus member and a row in its map.
- `npx eslint gnome-extension`, `node --test tests/extension/*.test.js` (new
  tests for ordering and the time formatter), `glib-compile-schemas --strict`,
  `cargo test -p isle-core`, plus the manual pass in fork.md.

## Risks

- **`compact.js` is upstream's newest code** (rewritten in 1.5.1): the countdown
  must go in through `_refresh`'s activity table and `_fit`'s width rules, not
  as a parallel path, or it will break the centred clock.
- **`Todo1.Add`'s signature changes**, so an old extension against a new isled
  (or the reverse) breaks reminders for that session. Both ship together; the
  changelog says to log out and back in.
- **The assistant's schema** (`remind {minutes}`) is in the prompt; changing it
  means re-testing each provider's JSON, and keeping "in ten minutes" working.
- **The strike fix** depends on how the label and its strike sit while a rename
  swaps in a field.

## Where it lands

`crates/isle-core/src/{when.rs, todo.rs, reminders.rs}`,
`crates/isle-daemon/src/{todo.rs, reminders.rs, assistant/mod.rs}`,
`gnome-extension/src/{reminders.js, compact.js, alerts.js, controller.js, voice.js, prefs.js}`,
`gnome-extension/src/pages/tasks.js`, the gschema, and the docs.
