// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The Reminders page's order, and the words beside a reminder's time, kept apart so tests run it anywhere
// (tests/).

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** A reminder's due time in ms, or null for a plain to-do (`due_ms` is 0 there). */
const dueOf = task => (task.due_ms > 0 ? task.due_ms : null);

/** The page's order: the late ones first (most late first), then the soonest, then the untimed as added. */
export function order(tasks) {
    return [...tasks].sort((a, b) => {
        const left = dueOf(a);
        const right = dueOf(b);
        if (left === null || right === null) {
            if (left === right)
                return a.id - b.id;
            return left === null ? 1 : -1;
        }
        return left - right || a.id - b.id;
    });
}

/** Whether a reminder's time has passed. */
export function isLate(task, now = Date.now()) {
    const due = dueOf(task);
    return due !== null && due <= now;
}

/**
 * What the row's time says: "12m late", "now", "17:00", "Tomorrow 09:30", "Tue 09:30", "10 Nov 09:30";
 * '' for a plain to-do. `time` turns a Date into a clock time ("17:00").
 */
export function whenText(task, now, time) {
    const due = dueOf(task);
    if (due === null)
        return '';
    const late = now - due;
    if (late >= 0) {
        const minutes = Math.floor(late / 60000);
        return minutes < 1 ? 'now' : `${spell(late)} late`;
    }
    const date = new Date(due);
    const days = Math.round((startOfDay(date) - startOfDay(new Date(now))) / DAY_MS);
    if (days === 0)
        return time(date);
    if (days === 1)
        return `Tomorrow ${time(date)}`;
    if (days < 7)
        return `${WEEKDAYS[date.getDay()]} ${time(date)}`;
    const year = date.getFullYear() === new Date(now).getFullYear() ? '' : ` ${date.getFullYear()}`;
    return `${date.getDate()} ${MONTHS[date.getMonth()]}${year} ${time(date)}`;
}

/**
 * The time words a row's field starts with, readable again by the same parser: "17:00", "tomorrow 09:30",
 * "Tue 09:00", "3 Nov 09:00"; '' for a plain to-do.
 */
export function editableWhen(task, now, time) {
    const due = dueOf(task);
    if (due === null)
        return '';
    const date = new Date(due);
    const days = Math.round((startOfDay(date) - startOfDay(new Date(now))) / DAY_MS);
    if (days === 0)
        return time(date);
    if (days === 1)
        return `tomorrow ${time(date)}`;
    if (days < 7)
        return `${WEEKDAYS[date.getDay()]} ${time(date)}`;
    return `${date.getDate()} ${MONTHS[date.getMonth()]} ${time(date)}`;
}

/** "12m", "2h", "2h 30m", "3d": how late, short enough for the row. */
function spell(ms) {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60)
        return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
    return `${Math.floor(hours / 24)}d`;
}

/** Midnight of a date, in local time. */
function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
