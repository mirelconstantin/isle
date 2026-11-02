// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Reminders, the right half of the Focus page (focus.js), in dark mode: an orange title and
// count, a ring and a hairline per reminder, and a last row to add one; a ticked one is struck, then goes.
// Each row is built by reminderRow.js; this page owns the list, the new row and the time sheet.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import * as Format from '../format.js';
import {order, repeatText, whenText} from '../reminderRules.js';
import {WhenSheet} from '../whenSheet.js';
import {iconButton, label} from '../widgets.js';
import {Page} from './page.js';
import {LINGER_MS, ReminderRow, STRIKE_MS, buildReminderRow, popTick, refreshRowTime, strikeLine} from './reminderRow.js';

/** How long it takes to fade and fold away. */
const LEAVE_MS = 260;
/** Typing pauses this long before the line is read for its time. */
const PARSE_MS = 150;
/** How often a row's time is said again ("12m late") while the page is open. */
const WHEN_MS = 30 * 1000;
/** A new reminder opening its row. */
const ARRIVE_MS = 220;

/** A clock time, as GNOME's 12/24-hour setting writes it ("17:00", "5:00 PM"). */
const clock = date => Format.timeOfDay(GLib.DateTime.new_from_unix_local(Math.floor(date.getTime() / 1000)));

/** What the new row's chip says: its time and, for one that comes back, how often ("Tomorrow 09:30 · Every Mon"). */
function newWhenText(due, repeat) {
    if (!due)
        return 'Add time';
    return [whenText({due_ms: due}, Date.now(), clock), repeatText(repeat)].filter(Boolean).join(' · ');
}

// The reminder list, kept in isled's todo store.
export const TasksPage = GObject.registerClass({
    Signals: {
        // The ▶ on a reminder: make it the focus session's task (id and title).
        'focus-task': {param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]},
    },
}, class TasksPage extends Page {
    /** `height` is the expanded island's page height. */
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-reminders',
            layout_manager: new Clutter.BinLayout(),
            height,
        });
        this.name = 'reminders';
        /** The reminder being renamed, if any; the list holds still meanwhile. */
        this._renaming = null;
        /** Reminders ticked a moment ago, on their way out; the list holds still meanwhile. */
        this._leaving = new Set();
        /** Ticked and gone, until isled reports them done. */
        this._gone = new Set();
        /** Each shown reminder's row by id, kept while the reminder is unchanged. */
        this._rows = new Map();
        /** What isled read from the line being typed, `{title, due_ms, repeat}`, or null. */
        this._parsed = null;
        /** Counts parses, so a slow answer to older text cannot set the chip. */
        this._parseSeq = 0;
        /** The time and repeat the new row will be added with, and whether a picker set them. */
        this._newDue = 0;
        this._newRepeat = '';
        this._newDuePicked = false;
        /** The line the pick was made for, so a later line with a time of its own takes over. */
        this._pickedText = '';
        /** The time sheet, and the reminder it is for (null: the new row). */
        this._whenSheet = null;
        this._whenTask = null;
        /** Words from the sheet are being read, so a second Done waits. */
        this._whenBusy = false;
        /** A typed time is being read: a second Enter cannot add it twice. */
        this._adding = false;
        /** Whether the list is empty, for the time the sheet covers it. */
        this._shownEmpty = true;

        const column = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true});
        column.add_child(this._buildHeader());
        this._list = new St.BoxLayout({...VERTICAL, style_class: 'isle-reminder-list'});
        this._scroll = new St.ScrollView({
            style_class: 'isle-reminder-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            // Scrolls with the wheel or touchpad; no scrollbar over the list.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(this._list);
        this._newRow = this._buildNewRow();
        // Under the new row when there are none.
        this._empty = label('', 'isle-reminders-empty', {x_align: Clutter.ActorAlign.CENTER, y_expand: true});
        // Between the timed ones and the plain to-dos, which would otherwise sink out of sight under them.
        this._group = label('No time', 'isle-reminder-group', {visible: false});
        this._list.add_child(this._group);
        this._middle = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._middle.add_child(this._scroll);
        this._middle.add_child(this._empty);
        column.add_child(this._middle);
        this.add_child(column);

        this._syncNewWhen();
        this.watch(['tasks'], () => this._update());
        this._update();
    }

    /** Open and done alike, as isled has them. */
    _tasks() {
        return this.daemon.state.tasks ?? [];
    }

    // What the rows ask of the page

    /** The reminder being renamed, if any. */
    get renaming() {
        return this._renaming;
    }

    /** Whether a reminder is on its way out after a tick. */
    isLeaving(id) {
        return this._leaving.has(id);
    }

    /** Takes the keyboard for typing in the page. */
    holdKeyboard() {
        this.emit('request-keyboard', true);
    }

    // Building

    /** "Reminders", the count of open ones, and +. */
    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'isle-reminders-header'});
        header.add_child(label('Reminders', 'isle-reminders-title', {x_expand: true}));
        this._count = label('', 'isle-reminders-count');
        header.add_child(this._count);
        // A small round button, as the other pages' actions, on the page's right edge.
        const add = iconButton('isle-plus-symbolic', 'isle-button-round isle-button-small isle-reminders-add',
            () => this._focusNew(), {size: 13, accessibleName: 'New reminder'});
        add.y_align = Clutter.ActorAlign.CENTER;
        header.add_child(add);
        return header;
    }

    // The last row: a faint ring and a field, where typing a title and Enter adds it.
    _buildNewRow() {
        // Never y_expand: its column fills the row, and that would pass up (see `_row`).
        const row = new St.BoxLayout({style_class: 'isle-reminder isle-reminder-new', y_expand: false});
        row.add_child(new St.Widget({style_class: 'isle-reminder-check faint', y_align: Clutter.ActorAlign.CENTER}));
        const column = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true});
        this._entry = new St.Entry({style_class: 'isle-reminder-field', hint_text: 'New reminder', can_focus: true, x_expand: true});
        const content = new St.BoxLayout({style_class: 'isle-reminder-content', y_expand: true});
        content.add_child(this._entry);
        // The time it will be added with ("Tomorrow 17:00"), or "Add time": clicking it opens the sheet.
        this._newWhen = new St.Button({style_class: 'isle-when-chip', can_focus: false,
            y_align: Clutter.ActorAlign.CENTER, accessible_name: 'Set a time'});
        this._newWhenLabel = label('', 'isle-when-chip-label');
        this._newWhenLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._newWhen.set_child(this._newWhenLabel);
        this._newWhen.connect('clicked', () => this.openWhen(null));
        content.add_child(this._newWhen);
        column.add_child(content);
        row.add_child(column);

        const text = this._entry.clutter_text;
        // Typing pauses: read the line for a time, as the page and the assistant read it.
        text.connect('text-changed', () => this._parseSoon());
        // Enter adds it and leaves the field ready for the next.
        text.connect('activate', () => this._add());
        // A click takes the keyboard (see the controller's `_onFieldPress`); Esc or a click outside gives it back.
        text.connect('key-press-event', (_text, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._stopAdding();
            return Clutter.EVENT_STOP;
        });
        return row;
    }

    /** The + button: into the new row's field, scrolled into view. */
    _focusNew() {
        // The sheet covers the list, its field among it.
        if (this._whenSheet)
            this._closeWhen();
        this.holdKeyboard();
        this._entry.grab_key_focus();
        this._revealNew();
    }

    /** Scrolls to the bottom once the list has laid out. */
    _revealNew() {
        this.later('reveal-new', 40, () => {
            const adjustment = this._scroll.vadjustment;
            adjustment.ease(adjustment.upper - adjustment.page_size, {duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
    }

    /** What isled reads `line` as: `{title, due_ms, repeat, line}`, or null when it cannot be asked. */
    async _parse(line) {
        if (!line)
            return null;
        const answer = await this.daemon.call('todo', 'Parse', line);
        if (!answer)
            return null;
        try {
            return {...JSON.parse(answer), line};
        } catch (e) {
            console.warn(`Isle: could not read that reminder: ${e.message}`);
            return null;
        }
    }

    /** Reads the line once typing pauses, and shows the time it found beside it. */
    _parseSoon() {
        const line = this._entry.text.trim();
        const seq = ++this._parseSeq;
        this.later('parse', PARSE_MS, async () => {
            const parsed = await this._parse(line);
            // A newer keystroke, or Isle stopping, since this was asked.
            if (seq !== this._parseSeq || this._destroyed)
                return;
            this._setParsed(parsed);
        });
    }

    /** Keeps what the line read as. A line with a time sets it; a picker's pick outlives a title edit,
     * until the line says a time of its own. */
    _setParsed(parsed) {
        this._parsed = parsed;
        // The line has not changed since the pick: the pick stands, whatever its words say.
        if (this._newDuePicked && parsed?.line === this._pickedText)
            return;
        const due = parsed?.due_ms > 0 ? parsed.due_ms : 0;
        if (due) {
            this._newDue = due;
            this._newRepeat = parsed.repeat ?? '';
            this._newDuePicked = false;
            this._pickedText = '';
        } else if (!this._newDuePicked) {
            this._newDue = 0;
            this._newRepeat = '';
        }
        this._syncNewWhen();
    }

    /** Says the new row's time ("Tomorrow 17:00"), or "Add time" when it has none. */
    _syncNewWhen() {
        this._newWhenLabel.text = newWhenText(this._newDue, this._newRepeat);
        this._newWhen.accessible_name = this._newDue ? 'Change the time' : 'Set a time';
        if (this._newDue)
            this._newWhen.add_style_class_name('set');
        else
            this._newWhen.remove_style_class_name('set');
    }

    /** Sends the typed line to isled: its title, the time it was read as or picked, and its repeat. */
    async _add() {
        if (this._adding)
            return;
        const text = this._entry.text.trim();
        if (!text)
            return;
        this._adding = true;
        try {
            // Enter can come before the pause that reads the line: read it now rather than lose its time.
            const parsed = this._parsed?.line === text ? this._parsed : await this._parse(text);
            // The title without the time words, as isled read them; the raw text when it could not be asked.
            const title = parsed?.title?.trim() || text;
            // A pick stands for the line it was made for; a line typed since with a time of its own wins.
            const picked = this._newDuePicked && this._pickedText === text;
            let due = this._newDue;
            let repeat = this._newRepeat;
            if (!picked && parsed?.due_ms > 0) {
                due = parsed.due_ms;
                repeat = parsed.repeat ?? '';
            }
            const id = await this.daemon.call('todo', 'Add', title, due, repeat);
            // isled could not be asked: the words stay where they are, and its own alert says why.
            if (!Number.isInteger(id))
                return;
            // Only if nothing was typed meanwhile.
            if (this._entry.text.trim() === text) {
                this._entry.text = '';
                this._newDue = 0;
                this._newRepeat = '';
                this._newDuePicked = false;
                this._pickedText = '';
                this._setParsed(null);
            }
            this._revealTask(id);
        } finally {
            this._adding = false;
        }
    }

    /** Scrolls to the row just added, wherever the order put it. */
    _revealTask(id) {
        this.later('reveal-task', 80, () => {
            const row = Number.isInteger(id) ? this._rows.get(id) : null;
            if (!row) {
                this._revealNew();
                return;
            }
            const adjustment = this._scroll.vadjustment;
            const top = row.y - 4;
            adjustment.ease(Math.max(0, Math.min(top, adjustment.upper - adjustment.page_size)),
                {duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
    }

    /** Clears the field, its time, and gives the keyboard back if it had it. */
    _stopAdding() {
        this._entry.text = '';
        this._newDue = 0;
        this._newRepeat = '';
        this._newDuePicked = false;
        this._pickedText = '';
        this._setParsed(null);
        if (this._entry.clutter_text.has_key_focus())
            this.emit('request-keyboard', false);
    }

    /** Forgets the new row's time and repeat, the line's words too until it is typed again. */
    _clearNewDue() {
        this._parseSeq++;
        this._newDue = 0;
        this._newRepeat = '';
        this._newDuePicked = false;
        this._pickedText = '';
        // The line may still say a time: forget it until the line changes.
        if (this._parsed?.line === this._entry.text.trim())
            this._parsed = {...this._parsed, due_ms: 0, repeat: ''};
        this._syncNewWhen();
    }

    // Showing

    /** Brings the rows in line with isled's list, unless a rename or a tick is under way. */
    _update() {
        if (this._renaming !== null || this._leaving.size > 0)
            return;
        const tasks = this._tasks();
        const open = tasks.filter(task => !task.done);
        // Forgotten once isled has them done, or gone for another reason.
        this._gone = new Set(open.filter(task => this._gone.has(task.id)).map(task => task.id));
        // Late first, then the soonest, then the untimed as they were added.
        const shown = order(open.filter(task => !this._gone.has(task.id)));
        this._count.text = String(shown.length);

        // The field stays in place, with what is typed in it and its focus, while the rows above it are
        // rebuilt: taking it off the stage, even for a moment, would drop the keyboard focus.
        if (!this._newRow.get_parent())
            this._list.add_child(this._newRow);
        // The rows of unchanged reminders stay; those of changed or gone ones go. Only what a row shows counts:
        // `alerted` changing as an alert shows must not rebuild it.
        const keys = new Map(shown.map(task => [task.id, JSON.stringify([task.title, task.due_ms, task.repeat])]));
        const going = [...this._rows].filter(([id, row]) => keys.get(id) !== row._key);
        // A row's field losing its focus as it is destroyed upsets the input method: let go of it first.
        const focus = global.stage.get_key_focus();
        if (focus && going.some(([, row]) => row.contains(focus)))
            global.stage.set_key_focus(null);
        for (const [id, row] of going) {
            // Before it goes: a destroyed row's `notify::mapped` still reaches `lit`.
            row._gone = true;
            row.destroy();
            this._rows.delete(id);
        }
        // One added while the list is on screen opens its row; on first showing, all are there.
        const known = this.mapped ? this._known : null;
        let previous = null;
        for (const task of shown) {
            let row = this._rows.get(task.id);
            if (!row) {
                row = buildReminderRow(this, task, clock);
                row._key = keys.get(task.id);
                this._rows.set(task.id, row);
                if (previous)
                    this._list.insert_child_above(row, previous);
                else
                    this._list.insert_child_at_index(row, 0);
                if (known && !known.has(task.id))
                    this._arrive(row);
            } else if (row.get_previous_sibling() !== previous) {
                if (previous)
                    this._list.set_child_above_sibling(row, previous);
                else
                    this._list.set_child_below_sibling(row, null);
            }
            previous = row;
        }
        // The plain to-dos, kept in sight under the timed ones by a quiet heading.
        const untimed = shown.find(task => !task.due_ms);
        this._group.visible = Boolean(untimed && shown.some(task => task.due_ms));
        if (this._group.visible)
            this._list.set_child_above_sibling(this._group, this._rows.get(untimed.id));
        this._known = new Set(shown.map(task => task.id));
        this._shownEmpty = shown.length === 0;
        this._syncWhen();
        this._empty.text = tasks.length > shown.length ? 'All done' : 'No reminders · type above, or press Super+K';
    }

    /** The list, or the time sheet over it; the empty line only when there is neither a list nor a sheet. */
    _syncWhen() {
        const sheet = Boolean(this._whenSheet);
        this._scroll.visible = !sheet;
        this._empty.visible = !sheet && this._shownEmpty;
    }

    /** Opens `row` from nothing to its height, fading in, while the rows below make room. */
    _arrive(row) {
        // At the list's width: a title that wraps is taller.
        const [, height] = row.get_preferred_height(this._list.width || -1);
        row.clip_to_allocation = true;
        row.height = 0;
        row.opacity = 0;
        // Rebuilt by the next update before it ended, it is stopped while torn down: leave it be then.
        let gone = false;
        row.connect('destroy', () => (gone = true));
        row.ease({
            height,
            opacity: 255,
            duration: ARRIVE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                if (gone)
                    return;
                row.height = -1;
                row.clip_to_allocation = false;
            },
        });
    }

    /** Moves the keyboard `delta` rows on; past the last one, into the new-reminder field. */
    focusRow(row, delta) {
        const rows = this._list.get_children().filter(child => child instanceof ReminderRow);
        const next = rows[rows.indexOf(row) + delta];
        if (!next && delta > 0) {
            this._focusNew();
            return;
        }
        if (!next)
            return;
        this.holdKeyboard();
        next.grab_key_focus();
    }

    // Ticks a reminder: the ring turns orange with a dot in it, the title is struck through, it lingers
    // a moment (a second tap undoes it), then fades and folds away.
    tick(task, row) {
        // Folding away already: too late to undo. A flag, not `reactive`: that restyles the box (:insensitive).
        if (row._folding)
            return;
        const name = `leave-${task.id}`;
        if (this._leaving.has(task.id)) {
            this.cancel(name);
            this._leaving.delete(task.id);
            row._check.remove_style_pseudo_class('checked');
            row._check.accessible_name = 'Mark as done';
            row._title.remove_style_class_name('done');
            popTick(row, false);
            row._strike.remove_transition('scale-x');
            row._strike.ease({scale_x: 0, duration: STRIKE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            return;
        }
        // A wrapped title: the strike goes on its first line, not between them.
        strikeLine(row, row._title);
        // The text's own width, as laid out (cut short with … when long); measured before restyling.
        // The strike's box, not the title's: the title is off it while being renamed.
        const box = row._strike.get_parent()?.width ?? 0;
        const [textWidth] = row._title.clutter_text.get_layout().get_pixel_size();
        this._leaving.add(task.id);
        row._check.add_style_pseudo_class('checked');
        row._check.accessible_name = 'Not done';
        // On the title alone: on the row it restyled every widget in it, in the click's frame.
        row._title.add_style_class_name('done');
        popTick(row, true);
        // Struck through from the left, as the dot pops in.
        row._strike.remove_transition('scale-x');
        row._strike.ease({
            scale_x: box > 0 ? Math.min(1, textWidth / box) : 1,
            duration: STRIKE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this.later(name, LINGER_MS, () => {
            // Folds away: the rows below slide up into its place; too late now to undo.
            row._folding = true;
            row.clip_to_allocation = true;
            row.ease({
                opacity: 0,
                height: 0,
                duration: LEAVE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    // Already settled by `onDeactivate`, whose rebuild is what stopped this; or Isle stopped.
                    if (this._destroyed || !this._leaving.delete(task.id))
                        return;
                    this._finishTick(task);
                    this._update();
                },
            });
        });
    }

    /** Ticks a reminder off in isled. One that comes back stays: its next moment is where it shows again. */
    _finishTick(task) {
        // A repeating one is never gone: isled moves it on, and its row comes back at the new time.
        if (!task.repeat)
            this._gone.add(task.id);
        this.daemon.call('todo', 'SetDone', task.id, true);
    }

    // The time

    /** Opens the time sheet for `task`, or for the new row when it is null. */
    openWhen(task) {
        if (this._whenSheet || this._renaming !== null || (task && this._leaving.has(task.id)))
            return;
        const due = task ? task.due_ms : this._newDue;
        this._whenTask = task;
        this._whenSheet = new WhenSheet({
            now: Date.now(),
            due_ms: due > 0 ? due : 0,
            repeat: task ? task.repeat ?? '' : this._newRepeat,
            title: task?.title ?? (this._entry.text.trim() || 'New reminder'),
            // The new row's own field already takes words; a row being changed has only this way to say
            // a day past the strip ("on 3 Nov").
            typed: Boolean(task),
            clock,
            onDone: (due_ms, repeat, text) => this._whenDone(due_ms, repeat, text),
            onCancel: () => this._closeWhen({focusEntry: true}),
        });
        this._middle.add_child(this._whenSheet);
        this._syncWhen();
        this.holdKeyboard();
        this._whenSheet.focus();
    }

    /** Applies what the sheet gave: a picked moment and repeat, or words to read first (null until then). */
    async _whenDone(due_ms, repeat, text) {
        const sheet = this._whenSheet;
        if (!sheet || this._whenBusy)
            return;
        const task = this._whenTask;
        if (text !== null) {
            // Read with the title in front, so the words keep the parser's "a time already past means tomorrow".
            this._whenBusy = true;
            let parsed;
            try {
                parsed = await this._parse(`${task?.title ?? ''} ${text}`.trim());
            } finally {
                this._whenBusy = false;
            }
            // Cancelled while the words were read: they belong to a sheet that is gone.
            if (this._whenSheet !== sheet)
                return;
            if (!parsed?.due_ms) {
                sheet.showError();
                return;
            }
            due_ms = parsed.due_ms;
            // The words name a repeat only when they say one ("every monday"); otherwise the reminder keeps
            // the rule it has, so moving a weekly one's time does not quietly stop it coming back.
            if (parsed.repeat)
                repeat = parsed.repeat;
        }
        if (task) {
            this._closeWhen();
            if (due_ms !== task.due_ms)
                this.daemon.call('todo', 'SetDue', task.id, due_ms);
            if (repeat !== (task.repeat ?? ''))
                this.daemon.call('todo', 'SetRepeat', task.id, repeat);
            return;
        }
        // The new row: a pick outlives a title edit, and a later line with a time takes over (see `_setParsed`).
        if (!due_ms) {
            this._clearNewDue();
        } else {
            this._parseSeq++;
            this._newDue = due_ms;
            this._newRepeat = repeat ?? '';
            this._newDuePicked = true;
            this._pickedText = this._entry.text.trim();
            this._syncNewWhen();
        }
        this._closeWhen({focusEntry: true});
    }

    /** Puts the list back; `focusEntry` returns the keyboard to the new row's field. */
    _closeWhen({focusEntry = false} = {}) {
        const wasNew = this._whenTask === null;
        this._whenTask = null;
        if (this._whenSheet) {
            this._whenSheet.destroy();
            this._whenSheet = null;
        }
        this._syncWhen();
        if (focusEntry && wasNew) {
            this.holdKeyboard();
            this._entry.grab_key_focus();
        } else {
            this._releaseKeyboard();
        }
    }

    // Renaming, for the rows

    /** A row's title is a field now: the list holds still until it is done. */
    beginRename(row) {
        this._renaming = row._task.id;
        // Built anew once renamed, with its title back in place of the field.
        row._key = null;
        this.holdKeyboard();
    }

    /** The field is done: `title` is the new one, or null to keep the old. */
    endRename(task, title) {
        if (this._renaming === task.id)
            this._renaming = null;
        if (title)
            this.daemon.call('todo', 'Rename', task.id, title);
        // After this event: it may come as focus moves, and the entry must outlive the move. Kept as the page
        // goes (a click outside closes it): its title must come back in place of the field.
        this.later('renamed', 0, () => {
            this._update();
            this._releaseKeyboard();
        }, {keep: true});
    }

    /** Gives the keyboard back, unless a field here still has it (focus moved from one to another). */
    _releaseKeyboard() {
        const focus = global.stage.get_key_focus();
        if (!focus || !this.contains(focus))
            this.emit('request-keyboard', false);
    }

    /** The page opened: its rows' times are said again as they age ("12m late"). */
    onActivate() {
        this._tickWhen();
    }

    /** Says each row's time again, and asks for another look while the page stays open. */
    _tickWhen() {
        const now = Date.now();
        for (const row of this._rows.values())
            refreshRowTime(row, now, clock);
        this.later('when', WHEN_MS, () => this._tickWhen());
    }

    /** Ends whatever was under way, so the list is settled next time. */
    onDeactivate() {
        this.cancel('when');
        this._stopAdding();
        if (this._whenSheet)
            this._closeWhen();
        // Nothing in the middle of anything: the list stays as it is, with no rebuild as the page goes.
        if (this._renaming === null && this._leaving.size === 0)
            return;
        const renaming = this._renaming !== null;
        this._renaming = null;
        // Closing cancels the linger: ticked ones are done now, so the list never stays frozen.
        for (const id of this._leaving) {
            const task = this._tasks().find(each => each.id === id);
            if (task)
                this._finishTick(task);
        }
        this._leaving.clear();
        this._update();
        // The rename ends with the rebuild, but its own release is cancelled as the page goes.
        if (renaming)
            this.emit('request-keyboard', false);
    }
});
