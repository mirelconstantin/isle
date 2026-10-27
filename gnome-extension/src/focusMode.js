// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Turns Do Not Disturb on for focus phases, and only ever undoes what it did.
// That is saved, so it survives the lock screen (DND stays on) and shell crashes.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** Keeps Do Not Disturb in step with the focus timer. */
export class FocusMode {
    /** Follows the pomodoro phase, the DND switch and the focus-dnd setting. */
    constructor(daemon, notifications, settings) {
        this._daemon = daemon;
        this._notifications = notifications;
        this._settings = settings;
        this._changing = false;
        // Turned off by hand while Isle was not running: it is theirs again.
        if (!notifications.dnd)
            this._owned = false;

        this._daemonId = daemon.connect('changed', (_daemon, key) => {
            if (key === 'pomodoro')
                this._sync();
        });
        this._dndId = notifications.connect('dnd-changed', () => {
            // The user turned it off themselves: it is theirs again.
            if (!this._changing && this._owned && !notifications.dnd)
                this._owned = false;
        });
        this._settingsId = settings.connect('changed::focus-dnd', () => this._sync());
        this._sync();
    }

    /** Whether Isle turned Do Not Disturb on and owes turning it off. */
    get _owned() {
        return this._settings.get_boolean('focus-dnd-owned');
    }

    /** Saves the claim, writing only when it changes. */
    set _owned(owned) {
        if (owned !== this._owned)
            this._settings.set_boolean('focus-dnd-owned', owned);
    }

    /** Turns DND on when a focus phase starts and off when Isle's own claim ends. */
    _sync() {
        const phase = this._daemon.state.pomodoro?.phase;
        // Not known until isled answers; don't switch anything off before.
        if (phase === undefined)
            return;
        // A paused focus session is still a focus session.
        const focusing = phase === 'focus' && this._settings.get_boolean('focus-dnd');
        if (focusing && !this._owned && !this._notifications.dnd) {
            this._owned = true;
            this._setDnd(true);
        } else if (!focusing && this._owned) {
            this._owned = false;
            this._setDnd(false);
        }
    }

    /** Sets DND without mistaking the change for the user's own. */
    _setDnd(on) {
        this._changing = true;
        this._notifications.dnd = on;
        this._changing = false;
    }

    /** Disconnects, and gives DND back unless the screen is locked. */
    destroy() {
        this._daemon.disconnect(this._daemonId);
        this._notifications.disconnect(this._dndId);
        this._settings.disconnect(this._settingsId);
        // Stay quiet on the lock screen during a focus session; otherwise
        // leave the desktop as the user had it.
        if (this._owned && !Main.sessionMode.isLocked) {
            this._owned = false;
            this._setDnd(false);
        }
    }
}
