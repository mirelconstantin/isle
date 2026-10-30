// SPDX-License-Identifier: GPL-3.0-or-later

// Devices: the devices connected now, with the battery each reports (isled reads BlueZ, and UPower
// for a mouse or keyboard on its own receiver).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import {icon, label} from '../widgets.js';
import {Page} from './page.js';

/** A device's battery reads low at or under this, as elsewhere on the island. */
const LOW_BATTERY = 20;

export const DevicesPage = GObject.registerClass(
class DevicesPage extends Page {
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-devices',
            layout_manager: new Clutter.BinLayout(),
            height,
        });
        this.name = 'devices';

        this._list = new St.BoxLayout({...VERTICAL, style_class: 'isle-devices-list'});
        this._scroll = new St.ScrollView({
            style_class: 'isle-devices-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            // Scrolls with the wheel or touchpad; no scrollbar over the list.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(this._list);

        this._empty = new St.BoxLayout({...VERTICAL, style_class: 'isle-empty', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._empty.add_child(new St.Icon({gicon: icon('isle-bluetooth-symbolic'), icon_size: 24, style_class: 'isle-empty-icon', x_align: Clutter.ActorAlign.CENTER}));
        this._empty.add_child(label('No devices', 'isle-empty-title', {x_align: Clutter.ActorAlign.CENTER}));
        this._empty.add_child(label('Connect a device', 'isle-empty-hint', {x_align: Clutter.ActorAlign.CENTER}));

        const middle = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        middle.add_child(this._scroll);
        middle.add_child(this._empty);
        this.add_child(middle);

        this.watch(['system'], () => this._update());
        this._update();
    }

    /** Connected devices, in name order; isled keeps the list current as they come and go. */
    _devices() {
        const devices = this.daemon.state.system?.bluetooth ?? [];
        return [...devices].sort((a, b) => a.name.localeCompare(b.name));
    }

    _update() {
        const devices = this._devices();
        // Built anew only when the devices or their batteries changed.
        const key = JSON.stringify(devices);
        if (key === this._key)
            return;
        this._key = key;
        this._list.destroy_all_children();
        for (const device of devices)
            this._list.add_child(this._row(device));
        this._scroll.visible = devices.length > 0;
        this._empty.visible = devices.length === 0;
    }

    _row(device) {
        const row = new St.BoxLayout({style_class: 'isle-device'});
        const glyph = device.icon || 'bluetooth';
        row.add_child(new St.Icon({
            gicon: icon(glyph.endsWith('-symbolic') ? glyph : `${glyph}-symbolic`),
            icon_size: 18,
            style_class: 'isle-device-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const title = label(device.name, 'isle-device-name', {x_expand: true});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(title);
        if (typeof device.battery === 'number') {
            const low = device.battery <= LOW_BATTERY;
            row.add_child(label(`${Math.round(device.battery)}%`, `isle-device-battery${low ? ' low' : ''}`));
        } else {
            row.add_child(label('No battery', 'isle-device-nobattery'));
        }
        return row;
    }
});
