// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// What the Shelf's search field means: plain words, plus `from:app`, `type:text|link|image|files` and
// `before:today|yesterday|7d|2026-10-20`. Pure, so it is tested without GNOME.

const KINDS = new Set(['text', 'link', 'image', 'files']);

/** Midnight starting the day `value` names, or 0 when it names none. */
function beforeTime(value, now = new Date()) {
    if (value === 'today')
        return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (value === 'yesterday')
        return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
    const days = value.match(/^(\d+)d$/);
    if (days)
        return now.getTime() - Number(days[1]) * 24 * 60 * 60 * 1000;
    const date = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (date)
        return new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).getTime();
    return 0;
}

/** `{terms, app, kind, before}` from what was typed; unknown operators stay plain words. */
export function parseQuery(raw, now = new Date()) {
    let terms = [];
    let app = '';
    let kind = '';
    let before = 0;
    for (const word of raw.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
        if (word.startsWith('from:') && word.length > 5)
            app = word.slice(5);
        else if (word.startsWith('type:') && KINDS.has(word.slice(5)))
            kind = word.slice(5);
        else if (word.startsWith('before:') && beforeTime(word.slice(7), now))
            before = beforeTime(word.slice(7), now);
        else
            terms.push(word);
    }
    return {terms: terms.join(' '), app, kind, before};
}
