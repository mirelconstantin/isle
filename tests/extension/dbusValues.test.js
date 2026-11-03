// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// What isled's 64-bit answers turn into: `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {toNumber} from '../../gnome-extension/src/dbusValues.js';

test('a number stays the number it is', () => {
    assert.equal(toNumber(7), 7);
    assert.equal(toNumber(0), 0);
});

test('a 64-bit value comes back as an array, and is the value inside it', () => {
    // GJS's shape for `Todo1.Add`: `[7]`, which `Number.isInteger` does not accept.
    assert.equal(toNumber([7]), 7);
    assert.equal(Number.isInteger([7]), false);
    assert.equal(toNumber([4294967301]), 4294967301);
});

test('a BigInt, or the value as its two halves, is the same id', () => {
    assert.equal(toNumber(7n), 7);
    assert.equal(toNumber([7, 0]), 7);
    assert.equal(toNumber([5, 1]), 4294967301);
});

test('anything else is no id at all', () => {
    assert.ok(Number.isNaN(toNumber(undefined)));
    assert.ok(Number.isNaN(toNumber(null)));
    assert.ok(Number.isNaN(toNumber('7')));
    assert.ok(Number.isNaN(toNumber([])));
    assert.ok(Number.isNaN(toNumber({})));
});
