// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The sound each occasion plays, as freedesktop sound-theme names: `play_from_theme` takes them from the
// theme in use (Zorin's, freedesktop's, whatever is set), falling back to freedesktop for any name the theme
// does not carry. Kept in one place, so choosing another sound is a one-line change here; the Sounds setting
// still silences them all.

export const SOUNDS = {
    /** A reminder's heads-up, minutes before: quiet, and gone by itself. */
    reminderSoon: 'message-new-instant',
    /** A reminder's hour: long, and hard to miss. */
    reminder: 'alarm-clock-elapsed',
    /** A timer or a focus session ending. */
    timer: 'complete',
    /** isled down: something is wrong. */
    error: 'dialog-error',
    /** The screen starts being recorded, and stops. */
    recordingStarted: 'dialog-warning',
    recordingStopped: 'battery-low',
    /** A copy landing in the clipboard history: the lightest tick there is. */
    copied: 'audio-volume-change',
};
