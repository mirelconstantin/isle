// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The Shelf's search operators; `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {parseQuery} from '../../gnome-extension/src/clipboardQuery.js';

test('plain words stay the search', () => {
    assert.deepEqual(parseQuery('  pull request  '), {terms: 'pull request', app: '', kind: '', before: 0});
});

test('from, type and before narrow it', () => {
    assert.deepEqual(parseQuery('from:chrome type:image sunset'),
        {terms: 'sunset', app: 'chrome', kind: 'image', before: 0});
    // A type Isle does not know is a word, not a silent filter.
    assert.deepEqual(parseQuery('type:pdf'), {terms: 'type:pdf', app: '', kind: '', before: 0});
});

test('before understands days and dates', () => {
    const now = new Date(2026, 9, 27, 12, 0, 0);
    assert.equal(parseQuery('before:today', now).before, new Date(2026, 9, 27).getTime());
    assert.equal(parseQuery('before:yesterday', now).before, new Date(2026, 9, 26).getTime());
    assert.equal(parseQuery('before:7d', now).before, now.getTime() - 7 * 24 * 60 * 60 * 1000);
    assert.equal(parseQuery('before:2026-10-20', now).before, new Date(2026, 9, 20).getTime());
    // Unreadable: left as a word, so nothing disappears without the user seeing why.
    assert.equal(parseQuery('before:soon', now).before, 0);
    assert.equal(parseQuery('before:soon', now).terms, 'before:soon');
});
