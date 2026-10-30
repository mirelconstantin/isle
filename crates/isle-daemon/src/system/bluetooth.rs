// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use zbus::fdo::{ObjectManagerProxy, PropertiesProxy};
use zbus::message::Type as MessageType;
use zbus::names::InterfaceName;
use zbus::object_server::InterfaceRef;
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue};
use zbus::{Connection, MatchRule, MessageStream};

use super::{BluetoothDevice, SystemEvent, SystemService, publish};

const BLUEZ: &str = "org.bluez";
const DEVICE: &str = "org.bluez.Device1";
const BATTERY: &str = "org.bluez.Battery1";
/// UPower's own battery devices: a mouse or keyboard on its USB receiver reports there and not in
/// BlueZ (Logitech's HID++), and GNOME's Power settings list it beside the Bluetooth ones.
const UPOWER: &str = "org.freedesktop.UPower";
const UPOWER_DEVICE: &str = "org.freedesktop.UPower.Device";
/// Where UPower keeps them, kept apart from BlueZ's own paths.
const UPOWER_PATH: &str = "/org/freedesktop/UPower/devices/";
/// The UPower kinds worth a row (its `Type`): mouse, keyboard, gaming input, pen, touchpad, headset,
/// speakers, headphones, other audio, remote control, wearable, toy.
const UPOWER_KINDS: [u32; 12] = [5, 6, 12, 13, 14, 17, 18, 19, 21, 22, 26, 27];
/// Headsets usually report their battery a moment after connecting.
const BATTERY_GRACE: Duration = Duration::from_millis(2500);

/// How often each device's `Connected` changed, by object path. A connection is announced
/// only if nothing changed during [`BATTERY_GRACE`], so a bounced device is not listed.
type Generations = Arc<Mutex<HashMap<String, u64>>>;

/// Follows BlueZ: connected devices and their batteries, with an alert as one connects or goes.
pub async fn watch(system: Connection, iface: InterfaceRef<SystemService>) -> anyhow::Result<()> {
    let manager = ObjectManagerProxy::builder(&system)
        .destination(BLUEZ)?
        .path("/")?
        .build()
        .await?;
    // Only devices' and their batteries' changes: adapters and media transports change often.
    let bluez_changes = futures_util::stream::select(
        properties_changed(&system, BLUEZ, DEVICE).await?,
        properties_changed(&system, BLUEZ, BATTERY).await?,
    );
    let upower_changes = futures_util::stream::select(
        properties_changed(&system, UPOWER, UPOWER_DEVICE).await?,
        // A receiver plugged in or taken out: UPower has no object manager, only these two.
        signals(&system, UPOWER, UPOWER).await?,
    );
    let mut changes = futures_util::stream::select(bluez_changes, upower_changes);
    let mut added = manager.receive_interfaces_added().await?;

    // Devices that were already connected when Isle started.
    let mut connected = Vec::new();
    for (path, interfaces) in manager.get_managed_objects().await? {
        let is_connected = interfaces
            .get(DEVICE)
            .and_then(|props| props.get("Connected"))
            .and_then(|v| bool::try_from(v).ok())
            .unwrap_or(false);
        if is_connected {
            // One device that cannot be read must not cost us the others.
            if let Ok(device) = read_device(&system, &path).await {
                connected.push(device);
            }
        }
    }
    connected.extend(upower_peripherals(&system).await);
    publish(&iface, |state| state.bluetooth = connected, None).await;
    let generations = Generations::default();

    loop {
        tokio::select! {
            Some(message) = changes.next() => {
                let Ok(message) = message else { continue };
                let header = message.header();
                let Some(path) = header.path() else { continue };
                if matches!(
                    header.member().map(|member| member.as_str()),
                    Some("DeviceAdded" | "DeviceRemoved")
                ) {
                    sync_peripherals(&system, &iface).await;
                    continue;
                }
                let Ok((interface, changed, _)) =
                    message.body().deserialize::<(String, HashMap<String, OwnedValue>, Vec<String>)>()
                else {
                    continue;
                };
                if interface == UPOWER_DEVICE {
                    sync_peripherals(&system, &iface).await;
                } else if interface == DEVICE {
                    if let Some(now) = changed.get("Connected").and_then(|v| bool::try_from(v).ok()) {
                        connection_changed(&system, &iface, &generations, path.to_owned(), now).await;
                    }
                } else if interface == BATTERY
                    && let Some(percent) = changed.get("Percentage").and_then(|v| u8::try_from(v).ok())
                {
                    set_battery(&iface, path.as_str(), percent).await;
                }
            }
            Some(signal) = added.next() => {
                let Ok(args) = signal.args() else { continue };
                let percent = args
                    .interfaces_and_properties()
                    .get(BATTERY)
                    .and_then(|props| props.get("Percentage"))
                    .and_then(|v| u8::try_from(v).ok());
                if let Some(percent) = percent {
                    set_battery(&iface, args.object_path().as_str(), percent).await;
                }
            }
            else => return Ok(()),
        }
    }
}

/// `service`'s `PropertiesChanged` signals for `interface`.
async fn properties_changed(
    system: &Connection,
    service: &str,
    interface: &str,
) -> zbus::Result<MessageStream> {
    let rule = MatchRule::builder()
        .msg_type(MessageType::Signal)
        .sender(service)?
        .interface("org.freedesktop.DBus.Properties")?
        .member("PropertiesChanged")?
        .arg(0, interface)?
        .build();
    MessageStream::for_match_rule(rule, system, None).await
}

/// Every signal `service` sends on `interface`.
async fn signals(
    system: &Connection,
    service: &str,
    interface: &str,
) -> zbus::Result<MessageStream> {
    let rule = MatchRule::builder()
        .msg_type(MessageType::Signal)
        .sender(service)?
        .interface(interface)?
        .build();
    MessageStream::for_match_rule(rule, system, None).await
}

/// A device connected or went; a connection is announced once it has held for `BATTERY_GRACE`.
async fn connection_changed(
    system: &Connection,
    iface: &InterfaceRef<SystemService>,
    generations: &Generations,
    path: ObjectPath<'static>,
    now_connected: bool,
) {
    let generation = {
        let mut generations = generations.lock().unwrap_or_else(|e| e.into_inner());
        let generation = generations.entry(path.to_string()).or_default();
        *generation += 1;
        *generation
    };

    if now_connected {
        let generations = generations.clone();
        let still_current = move |path: &ObjectPath<'_>| {
            let generations = generations.lock().unwrap_or_else(|e| e.into_inner());
            generations.get(path.as_str()) == Some(&generation)
        };
        // Wait for the battery level in a separate task, so other devices'
        // updates are not held up.
        let (system, iface) = (system.clone(), iface.clone());
        tokio::spawn(async move {
            tokio::time::sleep(BATTERY_GRACE).await;
            if !still_current(&path) {
                return;
            }
            let Ok(device) = read_device(&system, &path).await else {
                return;
            };
            // Reading the device took a round trip, so check again. From here we queue for the
            // state lock without yielding; a later disconnect queues behind and removes it again.
            if !still_current(&path) {
                return;
            }
            let event = SystemEvent::Bluetooth {
                connected: true,
                device: device.clone(),
            };
            publish(
                &iface,
                |state| {
                    state.bluetooth.retain(|d| d.path != device.path);
                    state.bluetooth.push(device);
                },
                Some(event),
            )
            .await;
        });
    } else {
        let known = iface
            .get()
            .await
            .state
            .bluetooth
            .iter()
            .find(|d| d.path == path.as_str())
            .cloned();
        let Some(device) = known else { return };
        let event = SystemEvent::Bluetooth {
            connected: false,
            device,
        };
        publish(
            iface,
            |state| state.bluetooth.retain(|d| d.path != path.as_str()),
            Some(event),
        )
        .await;
    }
}

/// A connected device's battery, as BlueZ reports it.
async fn set_battery(iface: &InterfaceRef<SystemService>, path: &str, percent: u8) {
    publish(
        iface,
        |state| {
            if let Some(device) = state.bluetooth.iter_mut().find(|d| d.path == path) {
                device.battery = Some(percent);
            }
        },
        None,
    )
    .await;
}

/// A device's name and icon, and its battery if it reports one.
async fn read_device(system: &Connection, path: &ObjectPath<'_>) -> zbus::Result<BluetoothDevice> {
    let properties = PropertiesProxy::builder(system)
        .destination(BLUEZ)?
        .path(path.to_owned())?
        .build()
        .await?;
    let device = properties
        .get_all(InterfaceName::from_static_str_unchecked(DEVICE))
        .await?;
    let text = |key: &str| {
        device
            .get(key)
            .and_then(|v| String::try_from(v.try_clone().ok()?).ok())
    };
    let battery = properties
        .get(
            InterfaceName::from_static_str_unchecked(BATTERY),
            "Percentage",
        )
        .await
        .ok()
        .and_then(|v| u8::try_from(v).ok());

    Ok(BluetoothDevice {
        path: path.to_string(),
        name: text("Alias")
            .or_else(|| text("Name"))
            .unwrap_or_else(|| "Bluetooth device".into()),
        icon: text("Icon").unwrap_or_else(|| "bluetooth".into()),
        battery,
    })
}

/// A UPower peripheral's row: its model, an icon from its kind and the battery it reports. None for
/// what is not a peripheral of its own (BlueZ's devices are listed already, with the names BlueZ has).
async fn read_peripheral(system: &Connection, path: &ObjectPath<'_>) -> Option<BluetoothDevice> {
    let properties = PropertiesProxy::builder(system)
        .destination(UPOWER)
        .ok()?
        .path(path.to_owned())
        .ok()?
        .build()
        .await
        .ok()?;
    let device = properties
        .get_all(InterfaceName::from_static_str_unchecked(UPOWER_DEVICE))
        .await
        .ok()?;
    let text = |key: &str| {
        device
            .get(key)
            .and_then(|v| String::try_from(v.try_clone().ok()?).ok())
    };
    let kind = device.get("Type").and_then(|v| u32::try_from(v).ok())?;
    let present = device
        .get("IsPresent")
        .and_then(|v| bool::try_from(v).ok())
        .unwrap_or(false);
    let percentage = device.get("Percentage").and_then(|v| f64::try_from(v).ok());
    let (icon, battery) = peripheral_row(text("NativePath").as_deref(), kind, present, percentage)?;
    Some(BluetoothDevice {
        path: path.to_string(),
        name: text("Model")
            .filter(|model| !model.is_empty())
            .unwrap_or_else(|| "Device".into()),
        icon: icon.into(),
        battery,
    })
}

/// What a UPower device's properties decide: the icon and the battery of a peripheral of its own that
/// is here, or None for anything else (BlueZ's own devices, a laptop battery, a device gone).
fn peripheral_row(
    native: Option<&str>,
    kind: u32,
    present: bool,
    percentage: Option<f64>,
) -> Option<(&'static str, Option<u8>)> {
    // BlueZ's devices are rows already, with the names and icons BlueZ gives them.
    if native.is_some_and(|native| native.starts_with("/org/bluez/"))
        || !UPOWER_KINDS.contains(&kind)
        || !present
    {
        return None;
    }
    let battery = percentage
        .filter(|percent| (0.0..=100.0).contains(percent))
        .map(|percent| percent.round() as u8);
    Some((upower_icon(kind), battery))
}

/// The icon of a UPower kind, named as BlueZ names the same devices.
fn upower_icon(kind: u32) -> &'static str {
    match kind {
        5 => "input-mouse",
        6 => "input-keyboard",
        12 | 27 => "input-gaming",
        13 => "input-tablet",
        14 => "input-touchpad",
        17 | 21 => "audio-headset",
        18 => "audio-speakers",
        19 => "audio-headphones",
        _ => "bluetooth",
    }
}

/// Every peripheral UPower reports on its own, by path so the state only changes when one does.
async fn upower_peripherals(system: &Connection) -> Vec<BluetoothDevice> {
    let Ok(proxy) = zbus::Proxy::new(system, UPOWER, "/org/freedesktop/UPower", UPOWER).await
    else {
        return Vec::new();
    };
    let paths: Vec<OwnedObjectPath> = match proxy.call("EnumerateDevices", &()).await {
        Ok(paths) => paths,
        Err(_) => return Vec::new(),
    };
    let mut found = Vec::new();
    for path in paths {
        if let Some(device) = read_peripheral(system, &path).await {
            found.push(device);
        }
    }
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found
}

/// Replaces UPower's rows with what it reports now; BlueZ's own stay as they are.
async fn sync_peripherals(system: &Connection, iface: &InterfaceRef<SystemService>) {
    let peripherals = upower_peripherals(system).await;
    publish(
        iface,
        |state| {
            state
                .bluetooth
                .retain(|device| !device.path.starts_with(UPOWER_PATH));
            state.bluetooth.extend(peripherals);
        },
        None,
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_receiver_mouse_is_a_row_and_bluez_keeps_its_own() {
        // Logitech's HID++ mouse: a battery UPower reports, no BlueZ device behind it.
        assert_eq!(
            peripheral_row(Some("hidpp_battery_0"), 5, true, Some(57.4)),
            Some(("input-mouse", Some(57)))
        );
        // UPower lists BlueZ's devices too; those rows come from BlueZ itself.
        assert_eq!(
            peripheral_row(
                Some("/org/bluez/hci0/dev_DB_26_5F_E4_E0_3A"),
                6,
                true,
                Some(30.0)
            ),
            None
        );
        // Switched off, or not a peripheral: no row.
        assert_eq!(
            peripheral_row(Some("hidpp_battery_0"), 5, false, Some(57.0)),
            None
        );
        assert_eq!(peripheral_row(Some("BAT1"), 2, true, Some(100.0)), None);
        // A level UPower cannot mean is no level at all.
        assert_eq!(
            peripheral_row(Some("hidpp_battery_0"), 5, true, Some(255.0)),
            Some(("input-mouse", None))
        );
    }
}
