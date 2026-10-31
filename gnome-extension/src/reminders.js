// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Shows isled's timed reminders: a quiet heads-up before one is due, then the reminder itself. They are the
// Reminders page's own rows with a time, so one that fell due while the screen was locked (and Isle was off)
// shows as soon as Isle is back, and one already shown is not shown again after a restart (isled keeps that).

import GLib from 'gi://GLib';

/** Waits are cut into naps this long: GLib's clock stops during suspend, the wall clock does not. */
const MAX_NAP_MS = 30 * 1000;

/** Watches isled's timed reminders and hands each one to the island at its heads-up and at its hour. */
export class ReminderWatcher {
    /**
     * `onDue({id, text, due_ms}, kind, done)` shows a reminder: `kind` is `'soon'` for the quiet heads-up or
     * `'now'` for the reminder itself, and `done` is called once it was on screen.
     */
    constructor(daemon, settings, onDue) {
        this._daemon = daemon;
        this._settings = settings;
        this._onDue = onDue;
        this._timeout = 0;
        /** Ids whose own alert is out, or on its way. */
        this._shown = new Set();
        /** Ids whose heads-up was given, or skipped as too late for one. */
        this._warned = new Set();
        /** The time each id was planned for, to notice one that changed. */
        this._planned = new Map();
        this._changedId = daemon.connect('changed', (_daemon, key) => {
            if (key === 'tasks')
                this._sync();
        });
        this._settingsId = settings.connect('changed::reminder-alert-minutes', () => this._sync());
        this._sync();
    }

    /** How long before its time the heads-up comes; 0 for none. */
    get _leadMs() {
        return Math.max(0, this._settings.get_int('reminder-alert-minutes')) * 60000;
    }

    /** The open reminders, soonest first. */
    _reminders() {
        return (this._daemon.state.tasks ?? [])
            .filter(task => !task.done && task.due_ms > 0)
            .sort((a, b) => a.due_ms - b.due_ms);
    }

    /** Shows what is due now and sets a timer for the next moment. */
    _sync() {
        if (this._timeout) {
            GLib.source_remove(this._timeout);
            this._timeout = 0;
        }
        const items = this._reminders();
        const now = Date.now();
        const lead = this._leadMs;

        // Forgotten: removed, ticked off, or no longer timed.
        for (const id of [...this._planned.keys()]) {
            if (!items.some(item => item.id === id)) {
                this._planned.delete(id);
                this._warned.delete(id);
                this._shown.delete(id);
            }
        }
        for (const item of items) {
            if (this._planned.get(item.id) === item.due_ms)
                continue;
            // A new or changed time: its heads-up counts only if that moment is still ahead (a snooze puts
            // the reminder ten minutes out, which is the lead itself, so it goes straight to its hour).
            this._planned.set(item.id, item.due_ms);
            this._shown.delete(item.id);
            if (lead > 0 && item.due_ms - lead > now)
                this._warned.delete(item.id);
            else
                this._warned.add(item.id);
        }

        for (const item of items) {
            // Already shown and noted by isled: nothing more.
            if (item.alerted)
                continue;
            const reminder = {id: item.id, text: item.title, due_ms: item.due_ms};
            // The quiet heads-up, once.
            if (!this._warned.has(item.id) && item.due_ms - lead <= now && item.due_ms > now) {
                this._warned.add(item.id);
                this._onDue(reminder, 'soon', () => {});
            }
            // The hour itself.
            if (item.due_ms <= now && !this._shown.has(item.id)) {
                this._shown.add(item.id);
                // isled keeps it shown (or not) for us: the alert may wait behind a fullscreen window.
                this._onDue(reminder, 'now',
                    () => this._daemon.call('todo', 'SetAlerted', item.id, true));
            }
        }

        // The next moment: a heads-up or an hour, whichever comes first.
        const moments = [];
        for (const item of items) {
            if (item.alerted)
                continue;
            if (!this._warned.has(item.id) && item.due_ms - lead > now)
                moments.push(item.due_ms - lead);
            if (!this._shown.has(item.id) && item.due_ms > now)
                moments.push(item.due_ms);
        }
        if (!moments.length)
            return;
        const wait = Math.min(MAX_NAP_MS, Math.min(...moments) - now + 50);
        this._timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, () => {
            this._timeout = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Stops the timer and lets go of isled's signals. */
    destroy() {
        if (this._timeout)
            GLib.source_remove(this._timeout);
        this._daemon.disconnect(this._changedId);
        this._settings.disconnect(this._settingsId);
    }
}
