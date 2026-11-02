# This fork: what it changes, and how to take an upstream release

This repository is [zickrian/isle](https://github.com/zickrian/isle) plus the
features listed in the README's *What this fork does differently*. Upstream
moves quickly — 1.5.1 rewrote the closed island, the island's drawing and the
MPRIS client — so this file exists to make the next merge boring: what we add,
which upstream code it leans on, and what to do when that code moves.

Merged up to **upstream v1.5.3** (`5f2ac15`, in `b9fc525`); our own work sits
on top of it. `docs/plan-reminders.md` records why timed reminders are built the
way they are.

## Rules

1. **Upstream is the trunk.** Our features ride on its architecture. When a
   file conflicts, take upstream's version and re-apply our hunk inside it —
   never keep our copy of a file upstream rewrote just to end the conflict.
   That is how a "merge" quietly undoes a release.
2. **Our guards are behaviour, not taste.** The taskbar/barless handling, the
   clock restore and the sheen are fixes for real bugs (see *Invariants*).
   They must survive every merge, even if they have to be re-expressed.
3. **A feature owns its setting key and its D-Bus member.** Nothing we add
   changes the meaning of an upstream one. If a key is shared (for example
   `focus-dnd-owned`, which is upstream's), say so here.
4. **Say it in the docs.** A feature lands with its line in
   [CHANGELOG.md](../CHANGELOG.md) under `[Unreleased]`, its settings rows, its
   `docs/dbus-api.md` entry and its paragraph in
   [product-spec.md](product-spec.md).
5. **The repo is not what runs.** Nothing here reaches the desktop until
   `./install.sh` and a log out and back in (Wayland loads an extension only at
   login). Before debugging "a bug in the new build", check the installed copy:
   `diff -r --exclude=gschemas.compiled gnome-extension
   ~/.local/share/gnome-shell/extensions/isle@zickrian.github.io` and
   `isled --version`. The journal is the shell's only voice:
   `journalctl -b -o cat | grep "Isle:"`.

Our own commits sit on top of that merge: `git log --oneline upstream/main..HEAD`
lists them, `git diff upstream/main..HEAD --stat` sizes them, and the map below
says what each part owns.

## The map

| Feature | Lives in | Leans on (upstream) | Check after a merge |
|---|---|---|---|
| Command surface, Super+K | `commandPalette.js`, `controller.js` (`_palette*`, `_onCommandKey`, `_syncCommandShortcut`, `_paletteData`), `expanded.js` (`PAGE_TABS`), `stylesheet.css` | `Island.addView`, the `_render` presentation switch, `Main.pushModal` keyboard grabs, `ExpandedView.pages`, `CalendarPage.todayEvents` | The `palette` case in `_render` still has `VOICE_RADIUS`/`PEEK_SHOULDER`/`PEEK_TOP_GLASS`; `_onClick` and `_onHoverChanged` still return early while `_paletteOpen`; `collapse()` still closes it first |
| Clipboard stack, Super+Alt+V | `pages/clips.js`, `pages/shelf.js` (`_setStackMode`, `_syncStackBar`, `pasteNext`, `enterStack`), `clipboardQuery.js`, `controller.js` (`_syncStackShortcut`, `_onStackKey`, `_syncClipboard`) | `Clipboard1`, `ShelfPage`'s controls row, `Main.wm.addKeybinding` | The shelf's fields it toggles (`_clear`, `_confirm`, `_search`, `_searchButton`, `_searchSpacer`, `_clipboardControls`) still exist; `clipboardQuery.js` still matches `isled`'s search |
| Timed reminders | `reminderRules.js`, `pages/tasks.js`, `reminders.js`, `alerts.js` (`reminder`, `reminderSoon`), `compact.js` (`_nextReminder`, `_syncReminder`, `_tickReminder`, `_reminderBell`/`_reminderPrimaryTime`), `isle-core/src/when.rs`, `isle-daemon/src/todo.rs`, `assistant/agenda.rs` | `Todo1` (ours: `Parse`, `SetDue`, `SetAlerted`, `Add(text, due_ms)`), `CompactView._refresh`'s left/right slots and `_fit`, `PeekView`'s `actions`, `Format.duration`/`timeOfDay` | `Reminders1` stays gone; the agenda lists timed to-dos as reminders; alone, a reminder is drawn as the timer is — bell left, countdown right (`_reminderPrimaryTime`), `mm:ss` each second, orange in the last minute; beside an activity it takes the right slot only when that is free |
| Devices page | `pages/devices.js`, `expanded.js` (`TABS.devices`), `controller.js` (`_pageMakers`), `prefs.js` (`PAGES`), `stylesheet.css` | `_pageMakers()` order, `TABS`, `System1.State` (`bluetooth` list) | The page is still added after Usage, and `hidden-pages` still reaches it |
| Timer figures, next meeting, reminder ▶ | `pages/timer.js` (`_buildTask`, `_buildStats`, `_buildNextMeeting`, `_syncStats`, `_syncNextMeeting`, `get tint`), `pages/tasks.js` (`focus-task`), `controller.js` (`_focusTask`, `_setMeeting`, `_onNextEvent`) | `TimerPage`'s steppers column and Start slot, `pomodoro` `State.history`, `CalendarPage`'s `next-event` | The rows are still children of the steppers column; `_syncLock` still locks only the Work/Break rows; `pageNamed('focus')` still matches `this.name` |
| Timed Do Not Disturb | `notifications.js` (`dndUntil`, `setDndFor`, `setDndUntilTomorrow`, `_clearTimedDnd`, `_resumeTimedDnd`), `pages/notifications.js` (the chevron), `focusMode.js` (`_timedDndActive`) | `NotificationCenter.dnd`, upstream's `focus-dnd-owned`, `show-banners` | A focus session and a timed DND still do not turn each other off; `dnd-until` survives a restart |
| Header Join pill | `expanded.js` (`setMeeting`, `_syncMeeting`, `meeting-requested`), `pages/calendar.js` (`next-event`, `refreshNextEvent`, `todayEvents`), `stylesheet.css` | `ExpandedView`'s header row and its width bookkeeping, `CalendarPage._scheduleAlarm` | The pill hides itself past the meeting's end; the header's width is still reserved so the clock does not move |
| Island sheen | `island.js`, four lines in `SHAPE_CODE` | The `ShapeFill` shader (`fill`, `tint`, `edge`, `edgeAlpha`) | It is still in the shader. Never bring back a Cairo `_draw`: 1.5.1 removed that path for a reason |
| Off-the-bar sizing and clock | `controller.js` (`_inTopBar`, `_barHeight`, `inBar`/`band` in `_render`, `_updateGeometry`, `_onPanelStyle`), `shell.js` (`height`, `blendsIn`, `clockShown`, `_gap`, `_clearBar`, `destroy`) | `TopBar.isTopPanel`, `TopBar.gap`, `Main.panel`'s style | See *Invariants*: `_gap` is a number from the first frame, and no size the island is given may exceed the display |
| Fork metadata | `metadata.json` (`url`, `version-name`), `Cargo.toml` (`repository`), `README.md`, `.github/workflows/ci.yml` (`workflow_dispatch`) | — | Upstream bumps `version-name` and the AUR files; take its number, keep our `url` |

## Conflict playbook

`controller.js` conflicts almost every time. Keep upstream's structure and add
our pieces back verbatim:

- fields in `_init` (`_meeting`, `_meetingLinks`, `_paletteOpen`) and
  `this._palette = new CommandPalette()` next to `this._voice`;
- `_island.addView(this._palette)` in the view list;
- the `palette` case in `_render`, the `_openPalette`/`_closePalette`/
  `_onPaletteChosen`/`_paletteData` methods, and the early returns in
  `_onClick` and `_onHoverChanged`;
- `DevicesPage` in `_pageMakers()`, and `TimerPage(daemon, settings, size)` —
  our signature has `settings`;
- the signal wiring in `_buildExpanded` (`next-event`, `meeting-requested`,
  `focus-task`);
- `_inTopBar` and the `inBar`/`band` lines in `_render` (see *Invariants*);
- `_expanded.topInset` and the expanded height: since 1.5.2 the open island fills
  the bar (`_barHeight`), and only the closed one is shorter by the gap.

The others, in order of how often they bite:

| File | What is ours | How to resolve |
|---|---|---|
| `expanded.js` | `devices` in `TABS`, `PAGE_TABS` export, the meeting pill and `setMeeting` | Keep both; add our tab last and our pill to the status row |
| `shell.js` | guards in `height`, `blendsIn`, `clockShown`, `_onPanelStyle`; `_gap` set before the panel is asked about and starting at 0; `_clearBar`/`_restoreClock` in `destroy` | Keep upstream's new work and the guards. Add any new bar class to `_clearBar`, and drop the ones upstream removed (1.5.2 removed `GAP_CLASS`). `destroy` keeps our `_clearBar`/`_restoreClock` and upstream's own restores (1.5.2 added the drag gesture's button) |
| `pages/timer.js` | `WEEK_DAYS`, `focusTime`, `dayKey`, the task/stats/next rows, `meeting-requested`, `get tint` | Take upstream's `_init`, steppers and locking, then add our three builders to the steppers column |
| `notifications.js`, `pages/notifications.js`, `focusMode.js` | timed DND | Keep upstream's DND handling, keep `dndUntil` and the ownership dance |
| `pages/shelf.js`, `pages/clips.js` | stack mode, retention, search filters | Keep both; the cards' click path is ours |
| `callServices.js`, `call.js`, `pages/call.js` | the service list and its order (Zoom and the rest before "meet"), the `pw-dump` fallback for the stream's owner, an app's call keeping to its own windows, the mute on the call's own stream, `raise()` out of the taskbar, the preview kept while sharing with its pill | Keep ours; the preview's layers (`_view`, `_placeholder`, `_corners`, `_hover`, `_badge`) and the two settings keys |
| `pages/calendar.js` | `next-event`, `refreshNextEvent`, `todayEvents`, `get tint` | Keep both; upstream's `_scheduleAlarm` is where `_syncNextEvent()` is called |
| `prefs.js`, the gschema | the keys below, the Shortcuts group, Devices in `PAGES`, `intChoiceRow` | Keep both; `glib-compile-schemas --strict` catches duplicate keys |
| Rust | `isle-core/pomodoro.rs` (history), `isle-daemon/pomodoro.rs` (`State.history`), `clipboard.rs` (`SetRetention`), `system/bluetooth.rs` (UPower HID++ devices) | Upstream rarely touches these; if it does, keep our fields and re-run `cargo test -p isle-core` |

## Ours: settings keys and D-Bus members

| Key | Type | Default | Used by |
|---|---|---|---|
| `command-shortcut` | `as` | `<Super>k` | Command surface |
| `clipboard-stack-shortcut` | `as` | `<Super><Alt>v` | Paste next |
| `clipboard-retention-days` | `i` | `0` (until pushed out) | `Clipboard1.SetRetention` |
| `focus-task-id`, `focus-task-title` | `s` | `''` | A reminder as the timer's task |
| `reminder-alert-minutes` | `i` | `10` | The heads-up before a reminder (0: none) |
| `call-preview-sharing` | `b` | `true` | Keep the call's preview while the screen is shared or recorded |
| `dnd-until` | `x` | `0` | Timed DND's end, kept across restarts |
| `dnd-owned` | `b` | `false` | Timed DND turned it on, so it may turn it off |

Shared, not ours: `focus-dnd-owned` is upstream's; our timed DND reads it so a
focus session and a timed DND leave each other alone.

D-Bus we added: `Clipboard1.SetRetention(x days)`, `history` in
`Pomodoro1.State`, and `Todo1`'s `Parse`, `SetDue`, `SetAlerted` and its
`Add(text, due_ms)` (with `due_ms` and `alerted` in `Items`). `Reminders1` is gone:
`reminders.json` is folded into `todo.json` once. `System1.State`'s `bluetooth` list is upstream's; our daemon
makes it include a mouse or keyboard on its own receiver.

## Invariants (do not lose these in a merge)

- **The island's size off the bar.** `_topBar.height` is 0 when `Main.panel` is
  not a top bar (a taskbar moved it, or the island is on another display). The
  closed island keeps the bar's size in that case; `inBar` therefore tests the
  height, not `_onBar`, and `band` is `height − gap`, never `top − gap` (which
  goes negative).
- **The open island's header** falls back to `HEADER_WITHOUT_BAR` where there is
  no top bar, again from `_inTopBar` — a negative inset rides up into the
  screen's edge.
- **The bar's gap is a number.** `TopBar._gap` is read as `gap = _gap × scale`,
  and the closed island's height is the bar's minus it. `_gap` used to be set
  only after "is this panel a top bar yet?", so at login it was `undefined` and
  the height `NaN` — which Clutter allocates as the whole screen (the island
  filled the display). It now starts at 0, is computed before the panel is
  asked about, and the getter never returns a non-finite value.
- **No size past the display.** `_render` clamps any view's height to the
  monitor and warns once (`Isle: … would be N px tall`): a wrong island is
  better than a black wall, and the line names the cause.
- **The D-Bus types match the Rust ones.** `due_ms` is `i64` in `isle-daemon`
  and therefore `x` in `daemon.js`'s XML — `t` (u64) fails at runtime with
  *Signature mismatch*, which no lint or test here would catch.
- **The clock and the bar's colour** are Isle's only where Isle put them: a
  panel another extension moved is never restyled (`_onPanelStyle` returns
  early) and never hidden (`clockShown` forces `true`).
- **The sheen is in the shader.** Four lines in `SHAPE_CODE`; no per-frame
  Cairo pass, no second drawing path.
- **Do Not Disturb ownership.** A focus session, a timed DND and the user each
  own a reason for DND to be on; turning one off never turns another's off.

## Taking an upstream release

```sh
git fetch upstream --tags                      # first, always: 1.5.2 and 1.5.3 shipped the same day
git log --oneline HEAD..upstream/main          # what is new
git branch -f backup/pre-<version> main        # a way back
git merge upstream/main --no-commit --no-ff    # resolve, then commit
```

Before committing:

```sh
npx eslint gnome-extension
node --test tests/extension/*.test.js
glib-compile-schemas --strict --dry-run gnome-extension/schemas
cargo check -p isle-core -p isle-daemon
cargo test  -p isle-core -p isle-daemon
```

`cargo` writes to `~/.cargo` and `target/`; where those are read-only, point it
inside the tree and delete them after:
`CARGO_HOME=$PWD/.cargo-home CARGO_TARGET_DIR=$PWD/.cargo-target cargo check`.

`cargo test -p isle-daemon` has five tests that need a session bus and a
writable `/proc` (`assistant::agent`, `assistant::tasks`,
`media::mpris::bus_tests`); without a session bus they fail with *Failed to
query AppArmor policy* and pass on a desktop session.

One check that catches what lint cannot — an import upstream renamed:

```sh
# named imports that no longer exist
python3 - <<'PY'
import re, glob, os
files = glob.glob('gnome-extension/**/*.js', recursive=True)
exports = {}
for f in files:
    s = open(f).read()
    names = set(re.findall(r'export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)', s))
    for m in re.finditer(r'export\s*\{([^}]*)\}', s):
        names |= {p.split(' as ')[-1].strip() for p in m.group(1).split(',') if p.strip()}
    exports[os.path.normpath(f)] = names
for f in files:
    s = open(f).read()
    for m in re.finditer(r"import\s*\{([^}]*)\}\s*from\s*['\"](\.[^'\"]+)['\"]", s):
        target = os.path.normpath(os.path.join(os.path.dirname(f), m.group(2)))
        for part in m.group(1).split(','):
            name = part.split(' as ')[0].strip()
            if name and name not in exports.get(target, set()):
                print(f'MISSING {name} from {m.group(2)} in {f}')
PY

```

Styles are not checked by anything. Our rules are exactly
`git diff upstream/main..HEAD -- gnome-extension/stylesheet.css`; after a merge,
read that diff again — a block of ours that vanished took its rule with it.

Then install and log out and back in (`./install.sh`), and walk the features
once — nothing automated covers them:

1. Super+K, type a word, Enter on *Add reminder*; the Reminders page shows it.
2. Super+V → Shelf → **Stack**, pick two cards, **Paste next** into a window.
3. Devices page lists a Bluetooth device and a mouse on its receiver.
4. Timer: today's figures under the steppers, the next meeting with **Join**,
   and a reminder's ▶ starting a session on it.
5. Notifications: the chevron by the moon sets DND for an hour, and says until
   when; a focus session leaves it on.
6. The header's blue **Join** pill appears ten minutes before a meeting.
7. The island on a display with no top bar: same size, and the clock is back.
8. The black island still shows its sheen from the top edge.

Finally, log it: a `[Unreleased]` entry in the changelog, and this file if a
feature moved.

## What upstream changed, as an example

| Upstream moved | We had to |
|---|---|
| Cairo `_draw` → the `ShapeFill` shader | Re-express the sheen as GLSL, drop the Cairo pass |
| `_onBar` narrowed to "on the primary display"; `TopBar.isTopPanel` took the rest | Keep `_inTopBar` for "in a real top bar", and feed the new `band` from the bar's height |
| `Theme.edge()` array → `{color, top, bottom}` | Nothing: our fallback went away with the shader |
| The Focus page's label → Timer (`name` stays `focus`) | Rename it in the changelog, README and spec; keep `pageNamed('focus')` |
| The closed island became content-sized with one sign each side | Nothing of ours lived in `compact.js`; the changelog's size numbers went away |
| `Super+V` gained a setting (`super-v`) | Both settings rows sit in Clipboard now |
| 1.5.2: the bar keeps its height; the closed island is shorter by the gap (`GAP_CLASS` gone) | `band` is still the closed island's; `_expanded.topInset` and the open island's height use the bar's full height; `_clearBar` lost `GAP_CLASS` |
| 1.5.2: a clock choice (`clock-format`), `wallClock.js`, `Format.setClockFormat` | Nothing: our times already go through `Format.timeOfDay`/`duration`; the reminder countdown follows the setting for free |
| 1.5.2: clipboard thumbnails (`thumb_width`/`thumb_height`, `clipRules.js`) | Keep our `SetRetention` row in `dbus-api.md` and upstream's `Items` shape |
