// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Shows isled's timed reminders when they are due. They are the Reminders page's own rows with a time, so
// one that fell due while the screen was locked (and Isle was off) shows as soon as Isle is back, and one
// already shown is not shown again after a restart (isled keeps that it was).

import GLib from 'gi://GLib';

/** Waits are cut into naps this long: GLib's clock stops during suspend, the wall clock does not. */
const MAX_NAP_MS = 30 * 1000;

/** Watches isled's timed reminders and hands each due one to the island once. */
export class ReminderWatcher {
    /** `onDue({id, text, due_ms}, done)` shows a reminder that is due, and calls `done` once it was on screen. */
    constructor(daemon, onDue) {
        this._daemon = daemon;
        this._onDue = onDue;
        this._timeout = 0;
        this._shown = new Set();
        this._changedId = daemon.connect('changed', (_daemon, key) => {
            if (key === 'tasks')
                this._sync();
        });
        this._sync();
    }

    /** The open reminders, soonest first. */
    _reminders() {
        return (this._daemon.state.tasks ?? [])
            .filter(task => !task.done && task.due_ms > 0)
            .sort((a, b) => a.due_ms - b.due_ms);
    }

    /** Shows what is due now and sets a timer for the next one. */
    _sync() {
        if (this._timeout) {
            GLib.source_remove(this._timeout);
            this._timeout = 0;
        }
        const items = this._reminders();
        // Only those isled still has: the rest were removed or ticked off.
        this._shown = new Set([...this._shown].filter(id => items.some(item => item.id === id)));
        const now = Date.now();
        for (const item of items) {
            // Already shown (this run, or before a restart: `alerted`), or still to come.
            if (item.alerted || item.due_ms > now || this._shown.has(item.id))
                continue;
            this._shown.add(item.id);
            // isled keeps it shown (or not) for us: the alert may be hidden by a fullscreen window.
            this._onDue({id: item.id, text: item.title, due_ms: item.due_ms},
                () => this._daemon.call('todo', 'SetAlerted', item.id, true));
        }
        const next = items.find(item => !item.alerted && item.due_ms > now);
        if (!next)
            return;
        const wait = Math.min(MAX_NAP_MS, next.due_ms - now + 50);
        this._timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, () => {
            this._timeout = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Stops the timer and lets go of isled's signal. */
    destroy() {
        if (this._timeout)
            GLib.source_remove(this._timeout);
        this._daemon.disconnect(this._changedId);
    }
}
