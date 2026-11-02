// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// One reminder's row: the tick ring, the title over a hairline (click it to rename), its time at the right
// (click it for the time sheet), and ▶ / × beside it while the row is lit. The page owns the list and the
// animation of a tick; the row asks it for what only it knows.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL, onUiScale} from '../compat.js';
import {isLate, repeatText, whenText} from '../reminderRules.js';
import {iconButton, label, onHover, wrapLines} from '../widgets.js';

/** A ticked reminder stays this long, struck through, so a second tap can undo it. */
export const LINGER_MS = 900;
/** The strike drawn across the title. */
export const STRIKE_MS = 180;
/** The dot popping into the ring. */
const TICK_MS = 200;
/** The longest the time may take before a long title is squeezed. */
const WHEN_WIDTH = 190;

/** The middle of a title's first line, in the title's own coordinates; null when it is one line (or not laid out). */
function firstLineMiddle(title) {
    try {
        const layout = title.clutter_text.get_layout();
        if (!layout || layout.get_line_count() < 2)
            return null;
        const [logical] = layout.get_line(0).get_extents();
        return (logical.y + logical.height / 2) / Pango.SCALE;
    } catch (e) {
        return null;
    }
}

/** A reminder's row, never shorter than it wants: the list's scroll view lays rows out at their minimum
 * height, and a box takes a wrapped title's minimum as one line. */
export const ReminderRow = GObject.registerClass(
class ReminderRow extends St.BoxLayout {
    /** Natural height as the minimum too. */
    vfunc_get_preferred_height(forWidth) {
        const [, natural] = super.vfunc_get_preferred_height(forWidth);
        return [natural, natural];
    }

    /** Shorter only while opening or folding: its contents keep their full height, cut below. Squeezed,
     * St would draw the ring at that size and keep it, blurred, once the row is whole. */
    vfunc_allocate(box) {
        const [, natural] = super.vfunc_get_preferred_height(box.get_width());
        if (box.get_height() >= natural) {
            super.vfunc_allocate(box);
            return;
        }
        const full = box.copy();
        full.y2 = box.y1 + natural;
        super.vfunc_allocate(full);
        this.set_allocation(box);
    }
});

/** What the row's time says: its time and, for one that comes back, how often ("· Every Mon"). */
export function whenLine(task, now, clock) {
    const when = whenText(task, now, clock);
    const repeat = repeatText(task.repeat);
    return [when, repeat].filter(Boolean).join(' · ');
}

/**
 * Builds one reminder's row. `page` gives it what only the page knows: the daemon, the keyboard, the time
 * sheet (`openWhen`), the rename (`beginRename`/`endRename`) and the tick (`tick`).
 */
export function buildReminderRow(page, task, clock) {
    // Never y_expand: its column fills it, and once a child changes (a rename) the row would ask to
    // expand too and take all the list's room.
    const row = new ReminderRow({style_class: 'isle-reminder', reactive: true, y_expand: false});
    row._task = task;

    // The tick box: a ring, and a dot that pops into it when ticked.
    const dot = new St.Widget({style_class: 'isle-reminder-dot', scale_x: 0, scale_y: 0, x_expand: true, y_expand: true});
    dot.set_pivot_point(0.5, 0.5);
    // By the first line of a title that wraps.
    const check = new St.Button({
        style_class: 'isle-reminder-check',
        child: dot,
        accessible_name: 'Mark as done',
        y_align: Clutter.ActorAlign.START,
    });
    row.add_child(check);

    // The title over a hairline that runs from the text to the edge.
    const column = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true});
    const content = new St.BoxLayout({style_class: 'isle-reminder-content', y_expand: true});
    const titleBox = new St.Widget({style_class: 'isle-reminder-title-box', layout_manager: new Clutter.BinLayout(),
        x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    const title = label(task.title, 'isle-reminder-title', {reactive: true, x_expand: true});
    // A long one wraps, to be read whole.
    wrapLines(title);
    // Click the title to rename it in place.
    title.connect('button-release-event', () => {
        // One rename at a time: starting another would rebuild the list mid focus change.
        if (page.renaming === null && !page.isLeaving(task.id))
            startRenaming(page, row, titleBox, title, task);
        return Clutter.EVENT_STOP;
    });
    // As wide as the box, scaled from the left to the text's width when ticked.
    const strike = new St.Widget({style_class: 'isle-reminder-strike', scale_x: 0, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    strike.set_pivot_point(0, 0.5);
    titleBox.add_child(title);
    titleBox.add_child(strike);
    content.add_child(titleBox);

    // Its time at the right ("17:00", "Tomorrow 09:30", "12m late", "· Every Mon"), or "Add time" for a
    // plain to-do; clicking it opens the time sheet.
    const when = new St.Button({
        style_class: 'isle-reminder-when-button',
        can_focus: false,
        y_align: Clutter.ActorAlign.START,
        accessible_name: task.due_ms ? 'Change the time' : 'Add a time',
    });
    const whenLabel = label(whenLine(task, Date.now(), clock), 'isle-reminder-when');
    whenLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    onUiScale(whenLabel, scale => (whenLabel.width = WHEN_WIDTH * scale));
    if (!task.due_ms)
        whenLabel.add_style_class_name('isle-reminder-when-add');
    if (isLate(task))
        whenLabel.add_style_class_name('late');
    when.set_child(whenLabel);
    when.connect('clicked', () => page.openWhen(task));

    // ▶ starts a focus session on it; × deletes it. Both sit to the left of the time, shown while the row
    // is lit (under the pointer, or with the keyboard in it). Their room is kept, so the time never moves
    // and can always be clicked.
    const focus = iconButton('isle-play-symbolic', 'isle-button-flat isle-reminder-focus',
        () => page.emit('focus-task', String(task.id), task.title),
        {size: 9, accessibleName: 'Focus on this reminder'});
    // Once: a double click would ask isled to delete what is already gone.
    let removing = false;
    const remove = iconButton('isle-close-symbolic', 'isle-button-flat isle-reminder-remove', () => {
        if (!removing) {
            removing = true;
            page.daemon.call('todo', 'Remove', task.id);
        }
    }, {size: 9, accessibleName: 'Delete reminder'});
    // The row is the control: its buttons are a pointer's shortcut, and the keyboard has its own keys.
    focus.can_focus = remove.can_focus = false;
    const actions = new St.BoxLayout({style_class: 'isle-reminder-actions',
        y_align: Clutter.ActorAlign.CENTER, opacity: 0, reactive: false});
    actions.add_child(focus);
    actions.add_child(remove);
    const slot = new St.BoxLayout({style_class: 'isle-reminder-slot', y_align: Clutter.ActorAlign.START});
    slot.add_child(actions);
    slot.add_child(when);
    content.add_child(slot);

    /** Lit: the pointer on it, or the keyboard in it. The buttons only take clicks while they show. */
    const lit = on => {
        // Going away: `notify::mapped` fires as the row is destroyed, and its label is gone by then.
        if (row._gone)
            return;
        actions.reactive = on;
        actions.ease({opacity: on ? 255 : 0, duration: 120});
    };
    onHover(row, hovered => lit(hovered || row._focused));
    row.can_focus = true;
    row.connect('key-focus-in', () => {
        row._focused = true;
        lit(true);
    });
    row.connect('key-focus-out', () => {
        row._focused = false;
        lit(false);
    });
    row.connect('key-press-event', (_row, event) => rowKey(page, row, task, titleBox, title, event));
    // A click on the row itself (not on its title or its buttons) gives it the keyboard, so ↑/↓ work.
    row.connect('button-release-event', (_row, event) => {
        if (event.get_button() === Clutter.BUTTON_PRIMARY && !row._focused) {
            page.holdKeyboard();
            row.grab_key_focus();
        }
        return Clutter.EVENT_PROPAGATE;
    });
    column.add_child(content);
    column.add_child(new St.Widget({style_class: 'isle-reminder-line'}));
    row.add_child(column);

    row._check = check;
    row._dot = dot;
    row._title = title;
    row._strike = strike;
    row._when = whenLabel;
    check.connect('clicked', () => page.tick(task, row));
    return row;
}

/** Says a row's time again as it ages ("12m late"), and its repeat with it. */
export function refreshRowTime(row, now, clock) {
    // A plain to-do keeps its "Add time".
    if (!row._task.due_ms)
        return;
    const text = whenLine(row._task, now, clock);
    if (row._when.text !== text)
        row._when.text = text;
    if (isLate(row._task, now))
        row._when.add_style_class_name('late');
    else
        row._when.remove_style_class_name('late');
}

/** The keyboard in a row: ↑/↓ between them, Space ticks, Enter renames, T sets the time, Delete removes. */
function rowKey(page, row, task, titleBox, title, event) {
    const key = event.get_key_symbol();
    if (key === Clutter.KEY_Up || key === Clutter.KEY_Down) {
        page.focusRow(row, key === Clutter.KEY_Up ? -1 : 1);
        return Clutter.EVENT_STOP;
    }
    if (key === Clutter.KEY_t || key === Clutter.KEY_T) {
        page.openWhen(task);
        return Clutter.EVENT_STOP;
    }
    if (key === Clutter.KEY_space) {
        row._check.emit('clicked');
        return Clutter.EVENT_STOP;
    }
    if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
        if (page.renaming === null && !page.isLeaving(task.id))
            startRenaming(page, row, titleBox, title, task);
        return Clutter.EVENT_STOP;
    }
    if (key === Clutter.KEY_Delete || key === Clutter.KEY_BackSpace) {
        page.daemon.call('todo', 'Remove', task.id);
        return Clutter.EVENT_STOP;
    }
    return Clutter.EVENT_PROPAGATE;
}

/** Swaps the title for a field; Enter or a click away saves, Esc cancels. */
function startRenaming(page, row, titleBox, title, task) {
    const entry = new St.Entry({style_class: 'isle-reminder-field', text: task.title, x_expand: true, can_focus: true});
    titleBox.replace_child(title, entry);
    page.beginRename(row);
    entry.grab_key_focus();
    entry.clutter_text.set_selection(0, -1);

    let finished = false;
    const finish = save => {
        if (finished)
            return;
        finished = true;
        const text = entry.text.trim();
        page.endRename(task, save && text && text !== task.title ? text : null);
    };
    entry.clutter_text.connect('activate', () => finish(true));
    // Clicking elsewhere keeps the new name, as in Files.
    entry.clutter_text.connect('key-focus-out', () => finish(true));
    entry.clutter_text.connect('key-press-event', (_text, event) => {
        if (event.get_key_symbol() !== Clutter.KEY_Escape)
            return Clutter.EVENT_PROPAGATE;
        finish(false);
        return Clutter.EVENT_STOP;
    });
}

/** The strike, from the left, on the first line of a title that wraps. */
export function strikeLine(row, title) {
    const middle = firstLineMiddle(title);
    if (middle === null)
        return;
    row._strike.y_align = Clutter.ActorAlign.START;
    row._strike.margin_top = Math.max(0, Math.round(middle - 1));
}

/** Pops the tick dot in (or out, undoing). */
export function popTick(row, shown) {
    row._dot.remove_all_transitions();
    row._dot.ease({
        scale_x: shown ? 1 : 0,
        scale_y: shown ? 1 : 0,
        duration: TICK_MS,
        mode: shown ? Clutter.AnimationMode.EASE_OUT_BACK : Clutter.AnimationMode.EASE_OUT_QUAD,
    });
}
