// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The command surface: one field over the island's pages, actions, clipboard, reminders, calendar, apps,
// and what to add. Type to narrow, ↑↓ to choose, Enter to run, Esc to close.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL, px} from './compat.js';
import * as Format from './format.js';
import {icon, label} from './widgets.js';

/** The panel's height below the top bar, in CSS pixels: enough for a section or two without covering the screen. */
const HEIGHT = 360;
const MAX_PER_SECTION = {pages: 12, actions: 10, clips: 5, tasks: 4, events: 4, apps: 6};
/** A clip's one-line title: its first line, cut. */
const CLIP_CHARS = 64;

/** The rows the surface offers for `query`, in the order they show. */
function buildRows(data, query) {
    const q = query.trim().toLowerCase();
    const sections = [];
    const add = (title, rows) => {
        if (rows.length)
            sections.push({title, rows});
    };
    const text = value => (value ?? '').toLowerCase();
    const rank = (haystack, title) => {
        const index = text(title).indexOf(q);
        return index >= 0 ? index : 1000 + text(haystack).indexOf(q);
    };
    const pick = (items, key, limit) => {
        if (!q)
            return items.slice(0, limit);
        return items
            .filter(item => text(key(item)).includes(q))
            .sort((a, b) => rank(key(a), key(a)) - rank(key(b), key(b)))
            .slice(0, limit);
    };

    add('Go to', pick(data.pages ?? [], page => page.title, MAX_PER_SECTION.pages)
        .map(page => ({kind: 'page', title: page.title, subtitle: 'Page', icon: page.icon, name: page.name})));

    add('Do', pick(data.actions ?? [], action => `${action.title} ${action.keywords ?? ''}`, MAX_PER_SECTION.actions)
        .map(action => ({kind: 'action', ...action})));

    // Records and apps wait for a word: with an empty field the surface is a launcher, not a dump.
    add('Clipboard', q ? pick(data.clips ?? [], clip => `${clip.title} ${clip.subtitle ?? ''}`, MAX_PER_SECTION.clips)
        .map(clip => ({kind: 'clip', ...clip})) : []);

    add('Reminders', q ? pick(data.tasks ?? [], task => task.title, MAX_PER_SECTION.tasks)
        .map(task => ({kind: 'task', ...task})) : []);

    add('Calendar', q ? pick(data.events ?? [], event => event.title, MAX_PER_SECTION.events)
        .map(event => ({kind: 'event', ...event})) : []);

    add('Apps', q ? pick(data.apps ?? [], app => app.title, MAX_PER_SECTION.apps)
        .map(app => ({kind: 'app', ...app})) : []);

    // Last, so a page or action named exactly wins Enter; with nothing else, these are what is left.
    if (q) {
        add('Add', [
            {kind: 'add-task', title: `Add task “${query.trim()}”`, subtitle: 'Reminders', icon: 'isle-tasks', query: query.trim()},
            {kind: 'add-event', title: `Add event “${query.trim()}”`, subtitle: 'Calendar · today, with the time in the text', icon: 'isle-calendar', query: query.trim()},
            {kind: 'ask', title: `Ask Isle “${query.trim()}”`, subtitle: 'The AI assistant', icon: 'isle-sparkle-symbolic', query: query.trim()},
        ]);
    }

    return sections;
}

/** A clip's one-line title: what it starts with, or its files' names. */
function clipTitle(item) {
    const line = (item.preview ?? '').split('\n').find(part => part.trim())?.trim() ?? '';
    return line.length > CLIP_CHARS ? `${line.slice(0, CLIP_CHARS - 1)}…` : line;
}

/** Signals: `chosen` (row), `closed`. */
export const CommandPalette = GObject.registerClass({
    Signals: {
        'chosen': {param_types: [GObject.TYPE_JSOBJECT]},
        'closed': {},
    },
}, class CommandPalette extends St.Widget {
    _init() {
        super._init({style_class: 'isle-palette', layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL})});
        this._data = {pages: [], actions: [], clips: [], tasks: [], events: [], apps: []};
        this._rows = [];
        this._selected = 0;

        const search = new St.BoxLayout({style_class: 'isle-palette-search'});
        search.add_child(new St.Icon({gicon: icon('isle-search'), icon_size: 15, style_class: 'isle-palette-search-icon',
            y_align: Clutter.ActorAlign.CENTER}));
        this._entry = new St.Entry({style_class: 'isle-palette-entry', hint_text: 'Search or type a command',
            can_focus: true, x_expand: true});
        this._entry.clutter_text.connect('text-changed', () => {
            this._selected = 0;
            this._refresh();
        });
        this._entry.clutter_text.connect('key-press-event', (_text, event) => this._onKey(event));
        search.add_child(this._entry);
        search.add_child(label('esc', 'isle-palette-key', {y_align: Clutter.ActorAlign.CENTER}));
        this.add_child(search);

        this._list = new St.BoxLayout({...VERTICAL, style_class: 'isle-palette-list'});
        this._scroll = new St.ScrollView({
            style_class: 'isle-palette-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(this._list);
        this.add_child(this._scroll);

        const footer = new St.BoxLayout({style_class: 'isle-palette-footer'});
        footer.add_child(label('↑↓ choose', 'isle-palette-hint', {x_expand: true}));
        footer.add_child(label('↵ run', 'isle-palette-hint'));
        this.add_child(footer);

        this.connect('notify::mapped', () => {
            if (this.mapped)
                this._entry.grab_key_focus();
        });
    }

    /** The width the island should have, in stage pixels. */
    get preferredWidth() {
        return px(600);
    }

    /** The height below the top bar, in stage pixels. */
    fit() {
        return px(HEIGHT);
    }

    /** Shows the surface over `data`, with an empty field. */
    open(data) {
        this._data = data;
        this._selected = 0;
        this._entry.text = '';
        this._refresh();
    }

    /** Gives the field the keyboard, once the island has shown it. */
    focus() {
        this._entry.grab_key_focus();
    }

    /** The rows for what is typed, in sections. */
    _refresh() {
        const sections = buildRows(this._data, this._entry.text);
        this._list.destroy_all_children();
        this._rows = [];
        if (!sections.length) {
            this._list.add_child(label('Type a page, action, clip, reminder, event or app',
                'isle-palette-empty', {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
            return;
        }
        for (const section of sections) {
            this._list.add_child(label(section.title, 'isle-palette-section'));
            for (const data of section.rows) {
                const button = this._row(data);
                this._list.add_child(button);
                this._rows.push({button, data});
            }
        }
        this._selected = Math.min(this._selected, this._rows.length - 1);
        this._syncSelection();
        // A new query starts at the top, not wherever the last one was scrolled.
        this._scroll.vadjustment.value = 0;
    }

    /** One result: its icon, title and subtitle. */
    _row(data) {
        const box = new St.BoxLayout({style_class: 'isle-palette-row-box', x_expand: true});
        const tile = new St.Bin({
            style_class: 'isle-palette-icon',
            y_align: Clutter.ActorAlign.CENTER,
            child: data.gicon
                ? new St.Icon({gicon: data.gicon, icon_size: 15})
                : new St.Icon({gicon: icon(data.icon ?? 'isle-open-symbolic'), icon_size: 14}),
        });
        box.add_child(tile);
        const texts = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const title = label(data.title, 'isle-palette-title', {x_expand: true});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        texts.add_child(title);
        if (data.subtitle) {
            const subtitle = label(data.subtitle, 'isle-palette-subtitle', {x_expand: true});
            subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            texts.add_child(subtitle);
        }
        box.add_child(texts);
        const button = new St.Button({style_class: 'isle-palette-row', child: box, can_focus: false, x_expand: true});
        button.connect('clicked', () => this._choose(data));
        return button;
    }

    /** The keyboard: ↑↓ move, Enter runs, Esc closes. */
    _onKey(event) {
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Up:
            this._move(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            this._move(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            this._chooseSelected();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Escape:
            this.emit('closed');
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _move(step) {
        if (!this._rows.length)
            return;
        this._selected = Math.min(this._rows.length - 1, Math.max(0, this._selected + step));
        this._syncSelection();
        this._reveal();
    }

    _syncSelection() {
        this._rows.forEach((row, index) => {
            if (index === this._selected)
                row.button.add_style_class_name('selected');
            else
                row.button.remove_style_class_name('selected');
        });
    }

    /** Keeps the chosen row in view. */
    _reveal() {
        const row = this._rows[this._selected]?.button;
        if (!row)
            return;
        const adjustment = this._scroll.vadjustment;
        const top = row.y;
        const bottom = top + row.height;
        if (top < adjustment.value)
            adjustment.value = top;
        else if (bottom > adjustment.value + adjustment.page_size)
            adjustment.value = bottom - adjustment.page_size;
    }

    _chooseSelected() {
        const data = this._rows[this._selected]?.data;
        if (data)
            this._choose(data);
    }

    _choose(data) {
        this.emit('chosen', data);
    }
});

/** A clipboard item as a palette row. */
export function clipRow(item, appName = '') {
    const fallback = item.kind === 'image' ? 'Image' : item.kind === 'files' ? 'Files' : 'Copied text';
    return {
        item,
        title: clipTitle(item) || fallback,
        subtitle: [item.kind === 'link' ? 'Link' : item.kind === 'files' ? 'Files' : item.kind === 'image' ? 'Image' : 'Text',
            appName, Format.ago(GLib.DateTime.new_from_unix_local(Math.floor(item.at_ms / 1000)))].filter(Boolean).join(' · '),
        icon: item.kind === 'link' ? 'isle-link' : item.kind === 'image' ? 'isle-image' : item.kind === 'files' ? 'isle-file' : 'isle-text',
    };
}
