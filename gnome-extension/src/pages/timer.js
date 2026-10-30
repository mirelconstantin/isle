// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Focus timer (Pomodoro), the Focus page. See docs/product-spec.md.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {timerColor} from '../compact.js';
import {VERTICAL, onUiScale, px} from '../compat.js';
import * as Format from '../format.js';
import {Ring, icon, iconButton, label, pillButton} from '../widgets.js';
import {Page} from './page.js';

/** The phase's name inside the ring, under the time. */
const PHASES = {
    idle: 'Focus',
    focus: 'Focus',
    short_break: 'Break',
    long_break: 'Long break',
};
const RING_SIZE = 104;
/** Reset and Start, at the right, in a slot as wide as both (CSS px): Reset appearing moves nothing. */
const CONTROLS_WIDTH = 152;
/** Shown until isled reports the timer: a fresh 25-minute focus session. */
const DEFAULT_STATE = {phase: 'idle', running: false, remaining_ms: 25 * 60000, duration_ms: 25 * 60000,
    today_sessions: 0, today_focus_ms: 0, history: []};
/** The lengths the steppers keep to, in minutes (as Settings). */
const STEPPERS = [
    {key: 'focus_minutes', label: 'Work', min: 1, max: 180},
    {key: 'short_break_minutes', label: 'Break', min: 1, max: 60},
];
/** The week's bars: seven days, the newest on the right. */
const WEEK_DAYS = 7;

/** "1h 15m", "25m": the day's focus, short enough for a line. */
function focusTime(ms) {
    const minutes = Math.round(Math.max(0, ms) / 60000);
    if (minutes < 60)
        return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

/** A local Date's "2026-10-20". */
function dayKey(date) {
    const pad = number => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The Focus page: a ring with the time left, the lengths of work and break as steppers, today's figures,
// and Start. A reminder can be the session's task, ticked off from here when it is done.
export const TimerPage = GObject.registerClass({
    Signals: {
        // The Join pill by the next meeting: open its link.
        'meeting-requested': {param_types: [GObject.TYPE_STRING]},
    },
}, class TimerPage extends Page {
    /** `height` is the expanded island's page height. */
    _init(daemon, settings, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-timer',
            layout_manager: new Clutter.BoxLayout(),
            height,
        });
        this.name = 'focus';
        this._settings = settings;
        this._nextMeeting = null;
        this._tintPhase = null;

        // A ring that fills clockwise as the phase runs; the time and the phase inside.
        const inside = new St.BoxLayout({...VERTICAL, y_align: Clutter.ActorAlign.CENTER});
        this._time = label('25:00', 'isle-timer-time', {x_align: Clutter.ActorAlign.CENTER});
        this._phase = label('Focus', 'isle-timer-phase', {x_align: Clutter.ActorAlign.CENTER});
        inside.add_child(this._time);
        inside.add_child(this._phase);
        this._ring = new Ring({size: RING_SIZE, lineWidth: 5, trackOpacity: 0.14, child: inside});
        this._ring.y_align = Clutter.ActorAlign.CENTER;
        this.add_child(this._ring);
        this.add_child(new St.Widget({x_expand: true}));

        const steppers = new St.BoxLayout({...VERTICAL, style_class: 'isle-steppers', y_align: Clutter.ActorAlign.CENTER});
        this._values = new Map();
        for (const stepper of STEPPERS)
            steppers.add_child(this._buildStepper(stepper));
        steppers.add_child(this._buildTask());
        steppers.add_child(this._buildStats());
        steppers.add_child(this._buildNextMeeting());
        this.add_child(steppers);
        this.add_child(new St.Widget({x_expand: true}));

        // Reset only once started; then Start, Pause or Resume.
        const controls = new St.BoxLayout({style_class: 'isle-timer-controls', x_expand: true,
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
        this._reset = iconButton('isle-reset', 'isle-button-round',
            () => daemon.call('pomodoro', 'Stop'), {size: 14, accessibleName: 'Reset the timer'});
        this._reset.y_align = Clutter.ActorAlign.CENTER;
        controls.add_child(this._reset);
        const pill = new St.BoxLayout({style_class: 'isle-start-pill-box'});
        this._playIcon = new St.Icon({gicon: icon('isle-play-symbolic'), icon_size: 13, y_align: Clutter.ActorAlign.CENTER});
        this._playLabel = label('Start', 'isle-start-pill-label');
        pill.add_child(this._playIcon);
        pill.add_child(this._playLabel);
        this._play = new St.Button({style_class: 'isle-start-pill', child: pill, can_focus: true, accessible_name: 'Start or pause'});
        this._play.connect('clicked', () => this._toggle());
        controls.add_child(this._play);
        const slot = new St.Widget({layout_manager: new Clutter.BinLayout()});
        onUiScale(slot, scale => (slot.width = CONTROLS_WIDTH * scale));
        slot.add_child(controls);
        this.add_child(slot);

        this.watch(['pomodoro'], () => this._update());
        this.watch(['pomodoroConfig'], () => this._syncSteppers());
        this._taskSettings = ['focus-task-id', 'focus-task-title'].map(key =>
            settings.connect(`changed::${key}`, () => this._update()));
        this.connect('destroy', () => this._taskSettings.forEach(id => settings.disconnect(id)));
        this._update();
        this._syncSteppers();
    }

    /** "Work  25  −  +": a length, and buttons a minute down or up. */
    _buildStepper({key, label: name, min, max}) {
        const row = new St.BoxLayout({style_class: 'isle-stepper'});
        row.add_child(label(name, 'isle-stepper-name'));
        const value = label('', 'isle-stepper-value');
        this._values.set(key, value);
        row.add_child(value);
        for (const [glyph, step, accessibleName] of [['isle-minus-symbolic', -1, `Shorter ${name.toLowerCase()}`],
            ['isle-plus-symbolic', 1, `Longer ${name.toLowerCase()}`]]) {
            row.add_child(iconButton(glyph, 'isle-button-flat isle-stepper-button',
                () => this._step(key, step, min, max), {size: 12, accessibleName}));
        }
        return row;
    }

    /** "Focusing on …" and Done, while a reminder is the session's task. */
    _buildTask() {
        this._taskRow = new St.BoxLayout({style_class: 'isle-focus-task', visible: false});
        this._taskLabel = label('', 'isle-focus-task-label', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._taskLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._taskDone = pillButton('Done', 'isle-pill-small isle-focus-done', () => this._finishTask());
        this._taskDone.y_align = Clutter.ActorAlign.CENTER;
        this._taskRow.add_child(this._taskLabel);
        this._taskRow.add_child(this._taskDone);
        return this._taskRow;
    }

    /** "3 sessions · 1h 15m today", with the week's little bars under it. */
    _buildStats() {
        const box = new St.BoxLayout({...VERTICAL, style_class: 'isle-focus-stats'});
        this._stats = label('', 'isle-focus-stats-text', {x_align: Clutter.ActorAlign.CENTER});
        this._week = new St.BoxLayout({style_class: 'isle-focus-week', x_align: Clutter.ActorAlign.CENTER});
        this._weekBars = [];
        for (let i = 0; i < WEEK_DAYS; i++) {
            const bar = new St.Widget({style_class: 'isle-focus-week-bar'});
            this._weekBars.push(bar);
            this._week.add_child(bar);
        }
        box.add_child(this._stats);
        box.add_child(this._week);
        return box;
    }

    /** The next meeting, with Join once it is close. */
    _buildNextMeeting() {
        this._nextRow = new St.BoxLayout({style_class: 'isle-focus-next', visible: false});
        this._nextRow.add_child(new St.Icon({gicon: icon('isle-video-symbolic'), icon_size: 11,
            style_class: 'isle-focus-next-icon', y_align: Clutter.ActorAlign.CENTER}));
        this._nextLabel = label('', 'isle-focus-next-label', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._nextLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._join = pillButton('Join', 'isle-pill-small isle-focus-join', () => {
            if (this._nextMeeting?.link)
                this.emit('meeting-requested', this._nextMeeting.link);
        });
        this._join.y_align = Clutter.ActorAlign.CENTER;
        this._nextRow.add_child(this._nextLabel);
        this._nextRow.add_child(this._join);
        return this._nextRow;
    }

    /** One stepper click, kept within `min`..`max` minutes. */
    _step(key, step, min, max) {
        // From what was last asked for: clicks faster than isled answers each count.
        const config = this._asked ?? this.daemon.state.pomodoroConfig;
        if (!config)
            return;
        const minutes = Math.min(max, Math.max(min, (config[key] ?? min) + step));
        if (minutes === config[key])
            return;
        this._asked = {...config, [key]: minutes};
        // Shown at once; isled's answer brings the same.
        this._values.get(key).text = String(minutes);
        this.daemon.call('pomodoro', 'SetConfig', JSON.stringify(this._asked));
    }

    /** Steppers show isled's lengths, or the clicks it hasn't answered yet. */
    _syncSteppers() {
        const config = this.daemon.state.pomodoroConfig;
        // isled has caught up with the clicks (or another change came): its config holds again.
        if (this._asked && (!config || STEPPERS.every(({key}) => config[key] === this._asked[key])))
            this._asked = null;
        const shown = this._asked ?? config;
        for (const {key} of STEPPERS)
            this._values.get(key).text = shown?.[key] !== undefined ? String(shown[key]) : '–';
    }

    /** Only once a session has started. */
    get relevant() {
        const state = this.daemon.state.pomodoro;
        return Boolean(state && state.phase !== 'idle');
    }

    /** A cool wash while focusing, green on a break. */
    get tint() {
        const phase = this.daemon.state.pomodoro?.phase;
        if (!phase || phase === 'idle')
            return null;
        return phase === 'focus' ? [0.10, 0.12, 0.16] : [0.05, 0.22, 0.12];
    }

    /** Start, Pause or Resume. */
    _toggle() {
        const state = this.daemon.state.pomodoro;
        this.daemon.call('pomodoro', state?.running ? 'Pause' : 'Start');
    }

    /** Ring, time, phase, figures and buttons from isled's timer state. */
    _update() {
        const state = this.daemon.state.pomodoro ?? DEFAULT_STATE;
        const idle = state.phase === 'idle';
        const remaining = this._remaining(state);

        this._ring.color = timerColor(state.phase);
        this._ring.progress = idle ? 0 : 1 - remaining / state.duration_ms;
        this._time.text = Format.duration(remaining);
        this._phase.text = PHASES[state.phase] ?? 'Focus';
        this._playIcon.gicon = icon(state.running ? 'isle-pause-symbolic' : 'isle-play-symbolic');
        this._playLabel.text = state.running ? 'Pause' : idle ? 'Start' : 'Resume';
        this._reset.visible = !idle;
        this._syncTask(state);
        this._syncStats(state);
        this._syncNextMeeting();
        if (state.phase !== this._tintPhase) {
            this._tintPhase = state.phase;
            this.emit('tint-changed');
        }
        this._scheduleTick(state);
    }

    /** In ms; counted locally from `ends_at_ms` while running. */
    _remaining(state) {
        return state.running ? Math.max(0, state.ends_at_ms - Format.nowMs()) : state.remaining_ms;
    }

    /** Re-renders just after the displayed second changes. */
    _scheduleTick(state) {
        if (!this.active || !state.running)
            return;
        const remaining = this._remaining(state);
        // At zero, isled's PhaseFinished brings the next state.
        if (remaining <= 0)
            return;
        this.later('tick', (remaining % 1000) + 15, () => this._update());
    }

    /** The reminder this session is for, while a focus phase runs. */
    _syncTask(state) {
        const id = this._settings.get_string('focus-task-id');
        const title = this._settings.get_string('focus-task-title');
        const show = Boolean(id && title) && state.phase === 'focus';
        if (this._taskRow.visible !== show)
            this._taskRow.visible = show;
        if (show) {
            const text = `Focusing on “${title}”`;
            if (this._taskLabel.text !== text)
                this._taskLabel.text = text;
        }
    }

    /** Ticks the reminder off, and lets go of it. */
    _finishTask() {
        const id = Number(this._settings.get_string('focus-task-id'));
        if (id)
            this.daemon.call('todo', 'SetDone', id, true);
        this._settings.set_string('focus-task-id', '');
        this._settings.set_string('focus-task-title', '');
        this._taskRow.visible = false;
    }

    /** Today's sessions and time, and the last week's bars. */
    _syncStats(state) {
        const sessions = state.today_sessions ?? 0;
        const focus = state.today_focus_ms ?? 0;
        const text = sessions
            ? `${sessions} session${sessions === 1 ? '' : 's'} · ${focusTime(focus)} today`
            : 'No focus yet today';
        if (this._stats.text !== text)
            this._stats.text = text;

        const byDate = new Map((state.history ?? []).map(day => [day.date, day.focus_ms]));
        const today = new Date();
        const days = [];
        for (let i = WEEK_DAYS - 1; i >= 0; i--)
            days.push(byDate.get(dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i))) ?? 0);
        const most = Math.max(...days, 1);
        this._weekBars.forEach((bar, index) => {
            const ratio = days[index] / most;
            const height = px(3 + 9 * ratio);
            const opacity = Math.round(70 + 185 * ratio);
            if (bar.height !== height)
                bar.height = height;
            if (bar.opacity !== opacity)
                bar.opacity = opacity;
        });
    }

    /** The next meeting `{title, start_ms, end_ms, link}`, or null. */
    set nextMeeting(meeting) {
        this._nextMeeting = meeting;
        this._syncNextMeeting();
    }

    /** "Next: Design review · 12m" within the hour, with Join in the last ten minutes. */
    _syncNextMeeting() {
        const meeting = this._nextMeeting;
        if (!meeting) {
            if (this._nextRow.visible)
                this._nextRow.visible = false;
            return;
        }
        const now = Date.now();
        const start = meeting.start_ms;
        const end = meeting.end_ms ?? start + 60 * 60 * 1000;
        if (now > end) {
            if (this._nextRow.visible)
                this._nextRow.visible = false;
            return;
        }
        const minutes = Math.ceil((start - now) / 60000);
        const show = now >= start || minutes <= 60;
        const text = now < start ? `Next: ${meeting.title} · ${minutes}m` : `Now: ${meeting.title}`;
        const join = now >= start || minutes <= 10;
        if (this._nextRow.visible !== show)
            this._nextRow.visible = show;
        if (this._nextLabel.text !== text)
            this._nextLabel.text = text;
        if (this._join.visible !== join)
            this._join.visible = join;
    }

    /** The time may be stale after a while off screen. */
    onActivate() {
        this._update();
    }

    /** Forgets unanswered clicks. */
    onDeactivate() {
        // A click isled refused, or a change from Settings meanwhile: what it holds shows next time.
        this._asked = null;
        this._syncSteppers();
    }
});
