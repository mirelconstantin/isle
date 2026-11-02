// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The Reminders page's order and times: `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {dayChoices, defaultDue, dueAt, editableWhen, isLate, lateness, minutesOf, order, pickerText,
    presetMoments, repeatChoices, repeatText, stepMinutes, stripDay, whenText} from '../../gnome-extension/src/reminderRules.js';

/** Saturday 2026-10-31 10:00, local. */
const NOW = new Date(2026, 9, 31, 10, 0).getTime();
/** A clock time as the page writes it, without the 12-hour question. */
const time = date => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
/** A day of October 2026, the month `NOW` is in. */
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
/** Any day of 2026; months count from 0. */
const on = (month, day, hour, minute = 0) => new Date(2026, month, day, hour, minute).getTime();

test('late first, then the soonest, then the untimed as added', () => {
    const tasks = [
        {id: 1, due_ms: at(31, 17)},
        {id: 2, due_ms: 0},
        {id: 3, due_ms: at(31, 9)}, // an hour late
        {id: 4, due_ms: at(31, 8)}, // two hours late
        {id: 5, due_ms: at(31, 11)},
        {id: 0, due_ms: 0},
    ];
    assert.deepEqual(order(tasks).map(task => task.id), [4, 3, 5, 1, 0, 2]);
});

test('a time in the past is late', () => {
    assert.equal(isLate({due_ms: at(31, 9)}, NOW), true);
    assert.equal(isLate({due_ms: at(31, 11)}, NOW), false);
    assert.equal(isLate({due_ms: 0}, NOW), false);
});

test('the time beside a reminder says how near it is', () => {
    assert.equal(whenText({due_ms: at(31, 17)}, NOW, time), '17:00');
    assert.equal(whenText({due_ms: on(10, 1, 9, 30)}, NOW, time), 'Tomorrow 09:30');
    assert.equal(whenText({due_ms: on(10, 3, 9)}, NOW, time), 'Tue 09:00');
    assert.equal(whenText({due_ms: on(10, 10, 9, 30)}, NOW, time), '10 Nov 09:30');
    assert.equal(whenText({due_ms: 0}, NOW, time), '');
});

test('a late one says by how much', () => {
    assert.equal(whenText({due_ms: NOW - 20_000}, NOW, time), 'now');
    assert.equal(whenText({due_ms: NOW - 12 * 60_000}, NOW, time), '12m late');
    assert.equal(whenText({due_ms: NOW - 2 * 60 * 60_000}, NOW, time), '2h late');
    assert.equal(whenText({due_ms: NOW - (2 * 60 + 30) * 60_000}, NOW, time), '2h 30m late');
    assert.equal(whenText({due_ms: NOW - 3 * 24 * 60 * 60_000}, NOW, time), '3d late');
});

test('the field starts with words the parser reads back', () => {
    assert.equal(editableWhen({due_ms: at(31, 17)}, NOW, time), '17:00');
    assert.equal(editableWhen({due_ms: on(10, 1, 9, 30)}, NOW, time), 'tomorrow 09:30');
    assert.equal(editableWhen({due_ms: on(10, 3, 9)}, NOW, time), 'Tue 09:00');
    assert.equal(editableWhen({due_ms: on(10, 10, 9)}, NOW, time), '10 Nov 09:00');
    assert.equal(editableWhen({due_ms: 0}, NOW, time), '');
});

test('another year says the year', () => {
    assert.equal(whenText({due_ms: new Date(2027, 0, 4, 9).getTime()}, NOW, time), '4 Jan 2027 09:00');
});

test('the sheet offers today and the week after', () => {
    const days = dayChoices(NOW);
    assert.deepEqual(days.map(day => day.label),
        ['Today', 'Tomorrow', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    assert.equal(days[0].ms, new Date(2026, 9, 31).getTime());
    assert.equal(days[7].ms, new Date(2026, 10, 7).getTime());
});

test('the sheet starts at the next quarter hour, an hour on', () => {
    assert.equal(defaultDue(NOW), new Date(2026, 9, 31, 11, 0).getTime());
    assert.equal(defaultDue(new Date(2026, 9, 31, 10, 1).getTime()), new Date(2026, 9, 31, 11, 15).getTime());
    assert.equal(defaultDue(new Date(2026, 9, 31, 23, 30).getTime()), new Date(2026, 10, 1, 0, 30).getTime());
});

test('a day and a time of day make the moment, and the time wraps', () => {
    const day = new Date(2026, 9, 31).getTime();
    const due = dueAt(day, 17 * 60 + 30);
    assert.equal(new Date(due).getHours(), 17);
    assert.equal(new Date(due).getMinutes(), 30);
    assert.equal(minutesOf(due), 17 * 60 + 30);
    assert.equal(stepMinutes(23 * 60 + 45, 15), 0);
    assert.equal(stepMinutes(0, -15), 23 * 60 + 45);
});

test('the sheet says the day as well as the time', () => {
    assert.equal(pickerText(at(31, 17), NOW, time), 'Today 17:00');
    assert.equal(pickerText(on(10, 1, 9, 30), NOW, time), 'Tomorrow 09:30');
    assert.equal(pickerText(on(10, 3, 9), NOW, time), 'Tue 09:00');
    assert.equal(pickerText(on(10, 10, 9, 30), NOW, time), '10 Nov 09:30');
    assert.equal(pickerText(new Date(2027, 0, 4, 9).getTime(), NOW, time), '4 Jan 2027 09:00');
});

test('a repeat reads as words, and says nothing for one that does not come back', () => {
    assert.equal(repeatText(''), '');
    assert.equal(repeatText(null), '');
    assert.equal(repeatText('day'), 'Every day');
    assert.equal(repeatText('weekday'), 'Weekdays');
    assert.equal(repeatText('mon'), 'Every Mon');
    assert.equal(repeatText('sun'), 'Every Sun');
    // A rule Isle does not know says nothing rather than something wrong.
    assert.equal(repeatText('fortnightly'), '');
});

test('the repeat chips follow the picked day', () => {
    // Saturday 31 October: its weekly chip is that Saturday.
    assert.deepEqual(repeatChoices(at(31, 17)), [
        {value: '', label: 'Once'},
        {value: 'day', label: 'Daily'},
        {value: 'weekday', label: 'Weekdays'},
        {value: 'sat', label: 'Every Sat'},
    ]);
    assert.equal(repeatChoices(on(10, 2, 9))[3].value, 'mon');
});

test('the one-click moments are an hour on, tonight and tomorrow morning', () => {
    assert.deepEqual(presetMoments(NOW, time), [
        {label: 'In 1 hour', ms: NOW + 60 * 60_000},
        {label: 'Tonight 18:00', ms: at(31, 18)},
        {label: 'Tomorrow 09:00', ms: on(10, 1, 9)},
    ]);
    // Past six in the evening, tonight is no longer offered.
    const evening = at(31, 19);
    assert.deepEqual(presetMoments(evening, time).map(preset => preset.label),
        ['In 1 hour', 'Tomorrow 09:00']);
});

test('the strip stops at its ends', () => {
    const days = dayChoices(NOW);
    assert.equal(stripDay(days, days[0].ms, 1), days[1].ms);
    assert.equal(stripDay(days, days[0].ms, -1), days[0].ms);
    assert.equal(stripDay(days, days[7].ms, 1), days[7].ms);
    assert.equal(stripDay(days, days[3].ms, -2), days[1].ms);
    // A day the strip does not hold starts it at the beginning.
    assert.equal(stripDay(days, on(11, 20, 9), 1), days[1].ms);
});

test('a moment says how late it is, and nothing while it is ahead', () => {
    assert.equal(lateness(NOW + 60_000, NOW), '');
    assert.equal(lateness(NOW - 20_000, NOW), 'now');
    assert.equal(lateness(NOW - 12 * 60_000, NOW), '12m late');
    assert.equal(lateness(NOW - 2 * 60 * 60_000, NOW), '2h late');
});
