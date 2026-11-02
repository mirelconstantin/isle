// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The Reminders page's order and times: `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {editableWhen, isLate, order, whenText} from '../../gnome-extension/src/reminderRules.js';

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
