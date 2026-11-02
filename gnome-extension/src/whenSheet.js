// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The time sheet of the Reminders page: the days, a quarter-hour stepper with three one-click moments, how
// often it comes back, and the line's words as the other way in. It replaces the list while a time is
// picked, so the page never changes height.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL, onUiScale} from './compat.js';
import {dayChoices, defaultDue, dueAt, editableWhen, lateness, minutesOf, pickerText, presetMoments,
    repeatChoices, stripDay, stepMinutes} from './reminderRules.js';
import {iconButton, label, pillButton} from './widgets.js';

/** One click of the time's − and +. */
const STEP_MINUTES = 15;

export const WhenSheet = GObject.registerClass(
class WhenSheet extends St.BoxLayout {
    /**
     * `due_ms` is where it opens (0 for the next quarter hour), `repeat` how it comes back ('' for once),
     * `title` is shown above, `typed` offers the line's words too (a row that is already timed), and
     * `clock(date)` writes a time as the island does. `onDone(due_ms, repeat, text)` gets a picked moment
     * and how often it comes back, or the words to read; `onCancel` the ×.
     */
    _init({now, due_ms, repeat, title, typed, clock, onDone, onCancel}) {
        super._init({...VERTICAL, style_class: 'isle-when-sheet', can_focus: true});
        this._now = now;
        this._clock = clock;
        this._onDone = onDone;
        this._onCancel = onCancel;
        this._typedAllowed = typed;
        this._days = dayChoices(now);
        this._canClear = due_ms > 0;
        this._repeat = repeat ?? '';

        const start = due_ms > 0 ? due_ms : defaultDue(now);
        const day = new Date(start);
        day.setHours(0, 0, 0, 0);
        this._day = day.getTime();
        this._minutes = minutesOf(start);
        // A day past the strip (a time set by typing, weeks out) starts in the words, which can say it.
        this._typed = this._typedAllowed && !this._days.some(each => each.ms === this._day);

        this.add_child(this._buildTop(title));
        this._picker = this._buildPicker();
        this._words = this._buildWords(due_ms);
        this.add_child(this._picker);
        this.add_child(this._words);
        this.add_child(this._buildBottom());
        this.connect('key-press-event', (_sheet, event) => this._onKey(event));
        this._sync();
    }

    /** The reminder's title, what the pick means ("Tomorrow 09:30"), Type, and ×. */
    _buildTop(title) {
        const top = new St.BoxLayout({style_class: 'isle-when-top'});
        const name = label(title, 'isle-when-title', {x_expand: true});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        top.add_child(name);
        this._effective = label('', 'isle-when-effective');
        top.add_child(this._effective);
        this._typeButton = pillButton('Type', 'isle-pill-small isle-when-type', () => this._toggleTyped());
        this._typeButton.can_focus = false;
        this._typeButton.visible = this._typedAllowed;
        top.add_child(this._typeButton);
        const close = iconButton('isle-close-symbolic', 'isle-button-flat isle-when-close', () => this._onCancel(),
            {size: 9, accessibleName: 'Cancel'});
        close.can_focus = false;
        top.add_child(close);
        return top;
    }

    /** The days, then the time between − and +, with a click for an hour on, tonight and tomorrow morning. */
    _buildPicker() {
        const picker = new St.BoxLayout({...VERTICAL, style_class: 'isle-when-picker'});
        const days = new St.BoxLayout({style_class: 'isle-when-days'});
        this._dayButtons = this._days.map(day => {
            const button = pillButton(day.label, 'isle-pill-small isle-when-day', () => {
                this._day = day.ms;
                this._sync();
            });
            // The sheet holds the keyboard; these are a pointer's shortcut, as a row's ▶ and × are.
            button.can_focus = false;
            days.add_child(button);
            return button;
        });
        picker.add_child(days);

        const time = new St.BoxLayout({style_class: 'isle-when-time-row'});
        const step = (icon, delta, accessibleName) => {
            const button = iconButton(icon, 'isle-button-flat isle-when-step', () => this._step(delta),
                {size: 9, accessibleName});
            button.can_focus = false;
            return button;
        };
        time.add_child(step('isle-minus-symbolic', -STEP_MINUTES, 'Earlier'));
        // One width for every time, so the + does not move as the digits change.
        this._time = label('', 'isle-when-time', {x_align: Clutter.ActorAlign.CENTER});
        onUiScale(this._time, scale => (this._time.width = 52 * scale));
        time.add_child(this._time);
        time.add_child(step('isle-plus-symbolic', STEP_MINUTES, 'Later'));
        time.add_child(new St.Widget({style_class: 'isle-when-gap'}));
        for (const preset of presetMoments(this._now, this._clock))
            time.add_child(this._preset(preset));
        picker.add_child(time);
        return picker;
    }

    /** A one-click moment ("In 1 hour", "Tonight 18:00"): its day and time are picked. */
    _preset({label: text, ms}) {
        const button = pillButton(text, 'isle-pill-small isle-when-preset', () => {
            const date = new Date(ms);
            date.setHours(0, 0, 0, 0);
            this._day = date.getTime();
            this._minutes = minutesOf(ms);
            this._sync();
        });
        button.can_focus = false;
        return button;
    }

    /** The line's words, for a time the strip cannot say ("on 3 Nov", "in 2h"). */
    _buildWords(due_ms) {
        const entry = new St.Entry({style_class: 'isle-reminder-field isle-when-words',
            text: due_ms > 0 ? editableWhen({due_ms}, this._now, this._clock) : '', x_expand: true, can_focus: true});
        entry.clutter_text.connect('activate', () => this._done());
        entry.clutter_text.connect('text-changed', () => this._clearError());
        entry.clutter_text.connect('key-press-event', (_text, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._onCancel();
            return Clutter.EVENT_STOP;
        });
        return entry;
    }

    /** How often it comes back, Clear and Done. */
    _buildBottom() {
        const bottom = new St.BoxLayout({style_class: 'isle-when-bottom'});
        this._repeatRow = new St.BoxLayout({style_class: 'isle-when-repeats'});
        bottom.add_child(this._repeatRow);
        bottom.add_child(new St.Widget({x_expand: true}));
        this._clear = pillButton('Clear', 'isle-pill-small isle-when-clear', () => this._onDone(0, '', null));
        this._clear.can_focus = false;
        bottom.add_child(this._clear);
        const done = pillButton('Done', 'isle-pill-small isle-pill-white isle-when-done', () => this._done());
        done.can_focus = false;
        bottom.add_child(done);
        return bottom;
    }

    /** Takes the keyboard: the words' field when they are shown, else the sheet's own keys. */
    focus() {
        if (this._typed)
            this._words.grab_key_focus();
        else
            this.grab_key_focus();
    }

    /** The moment picked. */
    _picked() {
        return dueAt(this._day, this._minutes);
    }

    _step(delta) {
        this._minutes = stepMinutes(this._minutes, delta);
        this._sync();
    }

    /** Shows the picked time, the selected day, and the repeat chips of that day; the words replace the picker. */
    _sync() {
        this._picker.visible = !this._typed;
        this._words.visible = this._typed;
        this._repeatRow.visible = !this._typed;
        this._typeButton.label = this._typed ? 'Pick' : 'Type';
        this._clear.visible = this._canClear || this._typed;
        const picked = this._picked();
        this._time.text = this._clock(new Date(picked));
        const late = lateness(picked, this._now);
        this._effective.text = `${pickerText(picked, this._now, this._clock)}${late ? ` · ${late}` : ''}`;
        this._days.forEach((day, index) => {
            if (day.ms === this._day)
                this._dayButtons[index].add_style_class_name('selected');
            else
                this._dayButtons[index].remove_style_class_name('selected');
        });
        this._syncRepeats();
    }

    /** The repeat chips, of the picked day: "Every Mon" is that Monday, so a new day moves it. */
    _syncRepeats() {
        const choices = repeatChoices(this._day);
        // A weekly repeat follows the day it was picked on.
        const weekly = choices[choices.length - 1].value;
        if (this._repeat && this._repeat !== 'day' && this._repeat !== 'weekday' && this._repeat !== weekly)
            this._repeat = weekly;
        // Rebuilt with the day: the weekly chip names that day.
        this._repeatRow.destroy_all_children();
        for (const choice of choices) {
            const button = pillButton(choice.label, 'isle-pill-small isle-when-repeat', () => {
                this._repeat = choice.value;
                this._sync();
            });
            button.can_focus = false;
            if (choice.value === this._repeat)
                button.add_style_class_name('selected');
            this._repeatRow.add_child(button);
        }
    }

    _toggleTyped() {
        if (!this._typed) {
            this._words.text = editableWhen({due_ms: this._picked()}, this._now, this._clock);
            this._typed = true;
        } else {
            this._typed = false;
        }
        this._sync();
        if (this._typed) {
            this._words.grab_key_focus();
            this._words.clutter_text.set_selection(0, -1);
        } else {
            this.grab_key_focus();
        }
    }

    /** The sheet's keyboard: ← → a day, ↑ ↓ a quarter hour, Enter keeps it, Delete clears it, Esc cancels. */
    _onKey(event) {
        // The words are the entry's: its arrows move the caret.
        if (this._typed)
            return Clutter.EVENT_PROPAGATE;
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape) {
            this._onCancel();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Left || key === Clutter.KEY_Right) {
            this._day = stripDay(this._days, this._day, key === Clutter.KEY_Left ? -1 : 1);
            this._sync();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Up || key === Clutter.KEY_Down) {
            this._step(key === Clutter.KEY_Up ? STEP_MINUTES : -STEP_MINUTES);
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
            this._done();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Delete || key === Clutter.KEY_BackSpace) {
            if (this._clear.visible)
                this._onDone(0, '', null);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /** A picked moment and its repeat, or the words as typed (empty clears it). */
    _done() {
        if (this._typed) {
            const text = this._words.text.trim();
            this._onDone(text ? null : 0, '', text || null);
            return;
        }
        this._onDone(this._picked(), this._repeat, null);
    }

    /** The words could not be read: say so, and keep the sheet open to fix them. */
    showError() {
        this._effective.text = 'Can’t read that time';
        this._effective.add_style_class_name('bad');
        this._words.add_style_class_name('bad');
        this._words.grab_key_focus();
    }

    _clearError() {
        if (!this._effective.has_style_class_name('bad'))
            return;
        this._effective.remove_style_class_name('bad');
        this._words.remove_style_class_name('bad');
        const late = lateness(this._picked(), this._now);
        this._effective.text = `${pickerText(this._picked(), this._now, this._clock)}${late ? ` · ${late}` : ''}`;
    }
}
);
