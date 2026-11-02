// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The Reminders page's order, and the words beside a reminder's time, kept apart so tests run it anywhere
// (tests/).

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_MINUTES = 24 * 60;
/** How many days the time sheet offers without typing: today and the week after. */
const PICKER_DAYS = 8;

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

/**
 * The days the time sheet offers: today and the week after, as `{ms, label}`, each at local midnight.
 * `label` is "Today", "Tomorrow", then the weekday ("Mon"), so a day is never two chips.
 */
export function dayChoices(now = Date.now()) {
    const first = new Date(now);
    first.setHours(0, 0, 0, 0);
    return Array.from({length: PICKER_DAYS}, (_, index) => {
        // `setDate` keeps local midnight across a daylight-saving change, which adding a day in ms would not.
        const date = new Date(first);
        date.setDate(first.getDate() + index);
        return {
            ms: date.getTime(),
            label: index === 0 ? 'Today' : index === 1 ? 'Tomorrow' : WEEKDAYS[date.getDay()],
        };
    });
}

/** The next quarter hour an hour from `now`: where the time sheet starts. */
export function defaultDue(now = Date.now()) {
    const date = new Date(now + 60 * 60 * 1000);
    date.setSeconds(0, 0);
    date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15);
    return date.getTime();
}

/** How a repeat reads beside a time ("Every day", "Weekdays", "Every Mon"); '' for one that doesn't come back. */
export function repeatText(repeat) {
    if (!repeat)
        return '';
    if (repeat === 'day')
        return 'Every day';
    if (repeat === 'weekday')
        return 'Weekdays';
    const at = WEEKDAYS.indexOf(repeat[0].toUpperCase() + repeat.slice(1, 3));
    return at < 0 ? '' : `Every ${WEEKDAYS[at]}`;
}

/**
 * The repeat chips the time sheet offers, as `{value, label}`: none, every day, weekdays, and the weekday
 * of `dayMs` itself ("Every Mon").
 */
export function repeatChoices(dayMs) {
    return [
        {value: '', label: 'Once'},
        {value: 'day', label: 'Daily'},
        {value: 'weekday', label: 'Weekdays'},
        {value: WEEKDAYS[new Date(dayMs).getDay()].toLowerCase(), label: `Every ${WEEKDAYS[new Date(dayMs).getDay()]}`},
    ];
}

/** The moments the sheet offers a click for, as `{label, ms}`: an hour on, tonight, and tomorrow morning. */
export function presetMoments(now, time) {
    const at = (dayOffset, hour) => {
        const date = new Date(now);
        date.setHours(hour, 0, 0, 0);
        date.setDate(date.getDate() + dayOffset);
        return date.getTime();
    };
    const presets = [{label: 'In 1 hour', ms: now + 60 * 60 * 1000}];
    const tonight = at(0, 18);
    if (tonight > now)
        presets.push({label: `Tonight ${time(new Date(tonight))}`, ms: tonight});
    const morning = at(1, 9);
    presets.push({label: `Tomorrow ${time(new Date(morning))}`, ms: morning});
    return presets;
}

/** The day `delta` chips along the strip, stopping at either end. */
export function stripDay(days, dayMs, delta) {
    const at = days.findIndex(day => day.ms === dayMs);
    const next = Math.max(0, Math.min(days.length - 1, (at < 0 ? 0 : at) + delta));
    return days[next].ms;
}

/** How late a moment is ("now", "12m late"), or '' when it is still ahead. */
export function lateness(ms, now = Date.now()) {
    const late = now - ms;
    if (late < 0)
        return '';
    return Math.floor(late / 60000) < 1 ? 'now' : `${spell(late)} late`;
}

/** The minutes after midnight of a moment, in local time. */
export function minutesOf(ms) {
    const date = new Date(ms);
    return date.getHours() * 60 + date.getMinutes();
}

/** A moment on `dayMs`'s local day, `minutes` after midnight. */
export function dueAt(dayMs, minutes) {
    const date = new Date(dayMs);
    date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    return date.getTime();
}

/** A time of day moved `delta` minutes, wrapped into the day (23:45 + 15 → 00:00). */
export function stepMinutes(minutes, delta) {
    return ((minutes + delta) % DAY_MINUTES + DAY_MINUTES) % DAY_MINUTES;
}

/** A time said with its day, for the sheet and a picked chip: "Today 17:00", "Tomorrow 09:30",
 * "Tue 09:00", "10 Nov 09:30". */
export function pickerText(ms, now, time) {
    const date = new Date(ms);
    const days = Math.round((startOfDay(date) - startOfDay(new Date(now))) / DAY_MS);
    if (days === 0)
        return `Today ${time(date)}`;
    if (days === 1)
        return `Tomorrow ${time(date)}`;
    if (days > 1 && days < 7)
        return `${WEEKDAYS[date.getDay()]} ${time(date)}`;
    const year = date.getFullYear() === new Date(now).getFullYear() ? '' : ` ${date.getFullYear()}`;
    return `${date.getDate()} ${MONTHS[date.getMonth()]}${year} ${time(date)}`;
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
