// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// GNOME's notifications via the island, which replaces the clock where GNOME shows them. Hides GNOME's
// banners and emits `banner` by GNOME's rules; Do Not Disturb is GNOME's own "show banners" setting.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

/** Signals: `changed` (the list), `seen-changed` (only what is seen), `updated` (one changed in place),
 * `banner` (notification: show it, then acknowledge it) and `dnd-changed`. */
export class NotificationCenter extends Signals.EventEmitter {
    /** `isleSettings` says whether GNOME keeps its own banners (`gnome-banners`). */
    constructor(isleSettings) {
        super();
        this._tray = Main.messageTray;
        this._sources = new Map();

        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._settingsChanged = this._settings.connect('changed::show-banners', () => this.emit('dnd-changed'));

        this._isleSettings = isleSettings;
        this._bannersChanged = isleSettings.connect('changed::gnome-banners', () => this._syncBanners());
        this._syncBanners();

        for (const source of this._tray.getSources())
            this._watch(source);
        this._sourceAdded = this._tray.connect('source-added', (_tray, source) => this._watch(source));
        this._sourceRemoved = this._tray.connect('source-removed', (_tray, source) => this._unwatch(source));
    }

    /** All notifications, newest first. */
    get notifications() {
        const all = [...this._sources.keys()].flatMap(source => source.notifications);
        return all.sort((a, b) => b.datetime.compare(a.datetime));
    }

    /** How many are not seen yet. */
    get unseenCount() {
        let count = 0;
        for (const source of this._sources.keys())
            count += source.notifications.filter(notification => !notification.acknowledged).length;
        return count;
    }

    /** Whether the unread dot shows. */
    get hasUnseen() {
        return [...this._sources.keys()].some(source => source.notifications.some(n => !n.acknowledged));
    }

    /** Do Not Disturb: GNOME's "show banners" turned off. */
    get dnd() {
        return !this._settings.get_boolean('show-banners');
    }

    /** Writes GNOME's own setting, so the top bar's switch agrees. */
    set dnd(on) {
        this._settings.set_boolean('show-banners', !on);
    }

    /** Marks every notification as seen, clearing the unread dot. */
    acknowledgeAll() {
        const unseen = [...this._sources.keys()].flatMap(source => source.notifications)
            .filter(notification => !notification.acknowledged);
        unseen.forEach(notification => (notification.acknowledged = true));
        if (unseen.length)
            this.emit('seen-changed');
    }

    /** Dismisses every notification the user may dismiss. */
    clearAll() {
        // Resident notifications (e.g. a running download) cannot be dismissed.
        for (const notification of this.notifications.filter(n => !n.resident))
            notification.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
    }

    /** Whether GNOME shows its own banners (as the user chose); else the island does. */
    get _gnomeBanners() {
        return this._isleSettings.get_boolean('gnome-banners');
    }

    /** Blocks or unblocks GNOME's banners to match the setting. */
    _syncBanners() {
        if (this._gnomeBanners && this._blocking)
            this._unblockBanners();
        else if (!this._gnomeBanners && !this._blocking)
            this._blockBanners();
    }

    // GNOME's banners are hidden by keeping the tray's `bannerBlocked` set. The calendar and overview set
    // it too, so their requests are remembered and applied again when the extension stops.
    _blockBanners() {
        this._blocking = true;
        const tray = this._tray;
        // The tray only has a setter, so read the field behind it.
        this._requestedBlock = tray._bannerBlocked;
        const center = this;
        Object.defineProperty(tray, 'bannerBlocked', {
            configurable: true,
            get() {
                return center._requestedBlock;
            },
            set(blocked) {
                center._requestedBlock = blocked;
            },
        });
        tray._bannerBlocked = true;
        tray._updateState();
    }

    // Drops the override and hands the tray back the block others asked for.
    _unblockBanners() {
        this._blocking = false;
        delete this._tray.bannerBlocked;
        this._tray._bannerBlocked = !this._requestedBlock;
        this._tray.bannerBlocked = this._requestedBlock;
    }

    /** Follows a source's notifications coming, going and asking for banners. */
    _watch(source) {
        if (this._sources.has(source))
            return;
        const ids = [
            source.connect('notification-added', (_source, notification) => {
                this._added = notification;
                this.emit('changed');
            }),
            source.connect('notification-removed', () => this.emit('changed')),
            source.connect('notification-request-banner', (_source, notification) => this._onBannerRequest(notification)),
        ];
        this._sources.set(source, ids);
        this.emit('changed');
    }

    /** Stops following a source that went away. */
    _unwatch(source) {
        const ids = this._sources.get(source);
        if (!ids)
            return;
        ids.forEach(id => source.disconnect(id));
        this._sources.delete(source);
        this.emit('changed');
    }

    /** A banner asked for one already listed means it was updated in place: `updated` once complete. */
    _onBannerRequest(notification) {
        const updated = notification !== this._added;
        this._added = null;
        this._onBanner(notification);
        if (updated) {
            Promise.resolve().then(() => {
                if (this._listed(notification))
                    this.emit('updated');
            });
        }
    }

    /** Whether it is still in the list, not dismissed meanwhile. */
    _listed(notification) {
        const source = notification.source;
        return this._sources.has(source) && source.notifications.includes(notification);
    }

    /** The same rules GNOME applies before showing a banner. */
    _onBanner(notification) {
        if (this._gnomeBanners || notification.acknowledged || notification.urgency === MessageTray.Urgency.LOW)
            return;
        const critical = notification.urgency === MessageTray.Urgency.CRITICAL;
        if (!critical && !notification.source.policy.showBanners)
            return;
        // An app updating one sets its text before its buttons: shown once the update is complete.
        Promise.resolve().then(() => {
            if (this._listed(notification) && !notification.acknowledged)
                this.emit('banner', notification);
        });
    }

    /** Marks `notification` seen, with its sound, once it was actually shown (see `banner`), as GNOME does. */
    acknowledge(notification) {
        if (notification.acknowledged)
            return;
        notification.playSound();
        notification.acknowledged = true;
        this.emit('seen-changed');
    }

    /** Posts Isle's own notification for a new version: in GNOME's list (and the island's Notifications
     * page) beside the update alert in the notch. The alert already says it, so this one asks for no banner
     * of its own. */
    announceUpdate(version, onOpen, packaged = false) {
        try {
            this._updateSource?.destroy();
            const source = new MessageTray.Source({
                title: 'Isle',
                iconName: 'software-update-available-symbolic',
            });
            this._tray.add(source);
            const notification = new MessageTray.Notification({
                source,
                title: `Isle ${version} is out`,
                body: packaged ? 'Update its package to get it' : 'Update in a click; your things stay',
            });
            notification.addAction('Update', onOpen);
            // The notch alert shows it already; this one is for the notification list.
            notification.acknowledged = true;
            source.addNotification(notification);
            this._updateSource = source;
            source.connect('destroy', () => {
                if (this._updateSource === source)
                    this._updateSource = null;
            });
        } catch (e) {
            // The API differs by GNOME version; the notch alert still tells it.
            console.warn(`Isle: could not post the update notification: ${e.message}`);
        }
    }

    /** Disconnects everything and gives GNOME its banners back. */
    destroy() {
        // Tell no one about changes made while tearing down.
        this.disconnectAll();
        this._updateSource?.destroy();
        this._updateSource = null;
        this._tray.disconnect(this._sourceAdded);
        this._tray.disconnect(this._sourceRemoved);
        for (const source of [...this._sources.keys()])
            this._unwatch(source);
        this._settings.disconnect(this._settingsChanged);
        this._isleSettings.disconnect(this._bannersChanged);
        if (this._blocking)
            this._unblockBanners();
    }
}

/** Plain text of a notification body that may contain Pango markup. */
export function plainBody(notification) {
    const body = notification.body ?? '';
    if (!notification.useBodyMarkup)
        return body;
    // Only <b>, <i> and <u> are tags, as GNOME reads them: "Ann <ann@example.com>" keeps its address.
    return body
        .replace(/<\/?[biu]>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

/** The notification's icon, falling back to its app's. */
export function notificationIcon(notification) {
    return notification.gicon ?? notification.source?.icon ?? null;
}
