// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Values isled hands back, where the shape GJS gives them is not the one the signature suggests.
// No GNOME imports, so tests run it anywhere (tests/).

/**
 * A call's 64-bit value (`t`) — a task's id — as a number. GJS unpacks a reply's 64-bit integers into an
 * array rather than a number (`Todo1.Add` answers `[7]`), and another GJS may hand back a BigInt, or the
 * value as its two 32-bit halves; all three become the id itself. NaN when it is none of them.
 */
export function toNumber(value) {
    if (typeof value === 'number')
        return value;
    if (typeof value === 'bigint')
        return Number(value);
    if (!Array.isArray(value) || !value.length)
        return NaN;
    return value.length === 1 ? Number(value[0]) : Number(value[0]) + Number(value[1]) * 2 ** 32;
}
