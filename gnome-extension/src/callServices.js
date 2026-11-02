// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Telling a web call's window by its title, needing nothing of GNOME, kept apart so tests run it anywhere (tests/).

/**
 * Call services named in window titles, for calls in a browser. The first match wins, so the services whose
 * names are their own come before the ones a title may merely mention: "Meet with Ana - Zoom" is a Zoom call,
 * and "Meet" alone is the only thing a Google Meet tab says.
 */
const SERVICES = [
    [/whatsapp/i, 'WhatsApp'],
    [/telegram/i, 'Telegram'],
    [/discord/i, 'Discord'],
    [/\bzoom\b/i, 'Zoom'],
    [/microsoft teams|\bteams\b/i, 'Microsoft Teams'],
    [/jitsi/i, 'Jitsi Meet'],
    [/slack/i, 'Slack'],
    [/messenger/i, 'Messenger'],
    [/\bsignal\b/i, 'Signal'],
    [/skype/i, 'Skype'],
    [/webex/i, 'Webex'],
    // Last: a meeting's own name may hold "meet" ("Meet and greet - Zoom").
    [/google meet|\bmeet\b/i, 'Google Meet'],
];

/** A title showing a call under way, not only the service: a Meet code ("kgm-mwyq-mge"), or the words. */
const IN_CALL = [/\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b/, /\b(call|calling|meeting|huddle|panggilan|rapat)\b/i];

/** Names a voice engine gives the microphone stream in place of its app's ("WEBRTC VoiceEngine", Discord's). */
const ENGINE_NAMES = /webrtc|voice ?engine/i;

/** Browsers, whose tabs hold web calls (Meet, Zoom, Teams on the web...). */
export const BROWSERS = /chrom|firefox|brave|edge|vivaldi|opera|epiphany|librewolf|zen/i;

/** Whether a microphone stream's name is its voice engine's, not its app's: never one to show. */
export function isEngineName(name) {
    return ENGINE_NAMES.test(name ?? '');
}

/** Of the microphone streams a call could be on (the mixer's order), the call's `current` one while still there:
 * another app opening the microphone mid-call doesn't take the call over. Else the first, or null. */
export function callStreamOf(streams, current) {
    return current && streams.includes(current) ? current : streams[0] ?? null;
}

/** Of `pactl list source-outputs` (in the C locale), the process holding source output `index`: {pid, binary}
 * (0 and null when not said), or null when the list doesn't have it. */
export function streamOwner(text, index) {
    for (const block of (text ?? '').split(/^Source Output #/m).slice(1)) {
        if (Number.parseInt(block, 10) !== index)
            continue;
        const property = key => new RegExp(`^\\s*${key.replaceAll('.', '\\.')} = "([^"]*)"`, 'm').exec(block)?.[1] ?? null;
        const pid = Number.parseInt(property('application.process.id') ?? '', 10);
        return {pid: pid > 0 ? pid : 0, binary: property('application.process.binary')};
    }
    return null;
}

/** Of `pw-dump`'s JSON, the process holding the input stream named `name`: {pid, binary} (0 and null when not
 * said), or null. What `streamOwner` reads from `pactl`, for a PipeWire system without pactl installed. */
export function ownerOfDump(text, name) {
    if (!name)
        return null;
    let objects;
    try {
        objects = JSON.parse(text ?? '');
    } catch {
        return null;
    }
    if (!Array.isArray(objects))
        return null;
    const wanted = name.toLowerCase();
    for (const object of objects) {
        const props = object?.info?.props ?? {};
        if (props['media.class'] !== 'Stream/Input/Audio')
            continue;
        const names = [props['application.name'], props['node.name'], props['media.name']]
            .filter(Boolean)
            .map(each => each.toLowerCase());
        if (!names.includes(wanted))
            continue;
        const pid = Number.parseInt(props['application.process.id'] ?? '', 10);
        return {pid: pid > 0 ? pid : 0, binary: props['application.process.binary'] ?? null};
    }
    return null;
}

/** The call service a window title names, or null. */
export function serviceOf(title) {
    return SERVICES.find(([pattern]) => pattern.test(title ?? ''))?.[1] ?? null;
}

/** Of `windows` ({title, focused}, most recently used first), the index of the one a call that just began
 * is in, or -1 when none names a service. WhatsApp Web open all day must not take a Meet call: a title showing
 * a call under way comes first, then the window in front, then the most recently used. */
export function callWindowIndex(windows) {
    let best = -1, bestScore = 0;
    windows.forEach(({title, focused}, index) => {
        if (!serviceOf(title))
            return;
        const score = 1 + (IN_CALL.some(pattern => pattern.test(title)) ? 4 : 0) + (focused ? 2 : 0);
        if (score > bestScore) {
            best = index;
            bestScore = score;
        }
    });
    return best;
}
