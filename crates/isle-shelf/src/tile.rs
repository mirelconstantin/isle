// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! A file's tile, one size for all, as in pages/files.js: drag it out, click to copy,
//! double-click to open, × to remove.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use gtk::{gdk, gdk_pixbuf, gio, glib, pango, prelude::*};
use gtk4 as gtk;
use log::warn;

use crate::service;
use crate::shelf::Item;

/// Sizes in logical pixels; keep them in step with pages/files.js.
const TILE_WIDTH: i32 = 84;
const PREVIEW_SIZE: i32 = 52;
/// A file type's icon, drawn inside the preview's square.
const ICON_SIZE: i32 = 46;
/// File names are cut to this width.
const NAME_WIDTH: i32 = 76;
/// The ×: a small round badge over the preview's top-right corner.
const REMOVE_SIZE: i32 = 18;
/// The preview's square plus room above it for the ×.
const FRAME_HEIGHT: i32 = PREVIEW_SIZE + 6;
/// Thumbnails are cut at twice their size, sharp on HiDPI screens too.
const THUMBNAIL_PIXELS: i32 = PREVIEW_SIZE * 2;
/// A new file's tile pops in for this long (see style.css).
const FRESH_FOR: Duration = Duration::from_millis(600);
/// How long "Copied" shows on the tile.
const COPIED_FOR: Duration = Duration::from_millis(1100);

/// Image types copied as the picture itself, so chat apps paste an image
/// rather than a file. Others (and these, if unreadable) go as a file.
const PICTURE_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/bmp",
    "image/tiff",
];

/// Builds the tile for `item`; `fresh` makes it pop in, `on_remove` gets its URI on ×.
pub fn new(item: &Item, fresh: bool, on_remove: impl Fn(String) + 'static) -> gtk::Widget {
    let file = gio::File::for_uri(&item.uri);
    // Known once the file's details arrive; until then it copies as a file.
    let content_type: Rc<RefCell<Option<String>>> = Rc::default();

    let preview = preview_square(&["preview"]);
    let icon = gtk::Image::builder()
        .icon_name("text-x-generic")
        .pixel_size(ICON_SIZE)
        .halign(gtk::Align::Center)
        .valign(gtk::Align::Center)
        .hexpand(true)
        .build();
    preview.append(&icon);
    load_preview(&file, &preview, &icon, &content_type);

    let copied = gtk::Box::builder()
        .css_classes(["copied"])
        .hexpand(false)
        .halign(gtk::Align::Fill)
        .valign(gtk::Align::Fill)
        .can_target(false)
        .build();
    copied.append(
        &gtk::Image::builder()
            .icon_name("object-select-symbolic")
            .pixel_size(18)
            .hexpand(true)
            .halign(gtk::Align::Center)
            .build(),
    );
    let preview_with_flash = gtk::Overlay::builder().child(&preview).build();
    preview_with_flash.add_overlay(&copied);

    let remove = gtk::Button::builder()
        .child(
            &gtk::Image::builder()
                .icon_name("window-close-symbolic")
                .pixel_size(10)
                .build(),
        )
        .css_classes(["remove"])
        .build();
    remove.update_property(&[gtk::accessible::Property::Label("Remove from the shelf")]);
    let uri = item.uri.clone();
    remove.connect_clicked(move |_| on_remove(uri.clone()));

    let frame = frame(&preview_with_flash, Some(&remove));
    let tile = tile_box(&frame, &item.name, fresh);

    // Dragging the tile hands the file to whatever it is dropped on.
    let source = gtk::DragSource::new();
    source.set_actions(gdk::DragAction::COPY);
    let dragged = file.clone();
    source.connect_prepare(move |_, _, _| {
        let files = gdk::FileList::from_array(std::slice::from_ref(&dragged));
        Some(gdk::ContentProvider::for_value(&files.to_value()))
    });
    let drag_icon = preview.clone();
    source.connect_drag_begin(move |source, _| {
        let paintable = gtk::WidgetPaintable::new(Some(&drag_icon));
        source.set_icon(Some(&paintable), PREVIEW_SIZE / 2, PREVIEW_SIZE / 2);
        service::announce_dragging(true);
    });
    // Also after a cancelled drag.
    source.connect_drag_end(|_, _, _| service::announce_dragging(false));
    tile.add_controller(source);

    // A click copies the file; a double click opens it. A drag cancels the
    // click, and the × has a click of its own.
    let click = gtk::GestureClick::new();
    click.connect_released(move |gesture, presses, x, y| {
        let Some(tile) = gesture.widget() else { return };
        if tile
            .pick(x, y, gtk::PickFlags::DEFAULT)
            .is_some_and(|target| {
                target.is_ancestor(&remove) || &target == remove.upcast_ref::<gtk::Widget>()
            })
        {
            return;
        }
        match presses {
            1 => {
                copy(&file, content_type.borrow().as_deref(), &tile);
                flash(&copied);
            }
            2 => open(&file, tile.root().and_downcast::<gtk::Window>()),
            _ => {}
        }
    });
    tile.add_controller(click);

    tile.upcast()
}

/// The rounded square the icon or thumbnail sits in.
fn preview_square(classes: &[&str]) -> gtk::Box {
    gtk::Box::builder()
        .width_request(PREVIEW_SIZE)
        .height_request(PREVIEW_SIZE)
        // Its icon expands within it only (see `tile_box`).
        .hexpand(false)
        .halign(gtk::Align::Center)
        .valign(gtk::Align::End)
        // Clips the thumbnail to the rounded corners.
        .overflow(gtk::Overflow::Hidden)
        .css_classes(classes)
        .build()
}

/// The preview, centred at the bottom of a box with room for the × above
/// its top-right corner.
fn frame(preview: &impl IsA<gtk::Widget>, remove: Option<&gtk::Button>) -> gtk::Overlay {
    let room = gtk::Box::builder()
        .width_request(TILE_WIDTH)
        .height_request(FRAME_HEIGHT)
        .build();
    let frame = gtk::Overlay::builder().child(&room).build();
    preview.set_halign(gtk::Align::Center);
    preview.set_valign(gtk::Align::End);
    frame.add_overlay(preview);
    if let Some(remove) = remove {
        remove.set_halign(gtk::Align::Start);
        remove.set_valign(gtk::Align::Start);
        remove.set_size_request(REMOVE_SIZE, REMOVE_SIZE);
        // Its centre a few pixels inside the preview's corner.
        remove.set_margin_start((TILE_WIDTH + PREVIEW_SIZE) / 2 - REMOVE_SIZE + 6);
        frame.add_overlay(remove);
    }
    frame
}

/// The frame above its name, in a fixed-width column.
fn tile_box(frame: &gtk::Overlay, name: &str, fresh: bool) -> gtk::Box {
    // NAME_WIDTH wide and two lines, as in the island: a tiny natural width keeps a long name from
    // widening the tile, and only a longer name loses its middle.
    let label = gtk::Label::builder()
        .label(name)
        .wrap(true)
        .wrap_mode(pango::WrapMode::WordChar)
        .lines(2)
        .justify(gtk::Justification::Center)
        .valign(gtk::Align::Start)
        .ellipsize(pango::EllipsizeMode::Middle)
        .width_request(NAME_WIDTH)
        .max_width_chars(1)
        .halign(gtk::Align::Center)
        .css_classes(["name"])
        .build();
    // Never wider than that: set outright, so the icon's expanding (to centre it) can't reach the
    // row and give one tile all the room left over.
    let tile = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(4)
        .width_request(TILE_WIDTH)
        .hexpand(false)
        .valign(gtk::Align::Center)
        .css_classes(["tile"])
        .build();
    if fresh {
        // Only once: a tile is moved about later, which would replay it.
        tile.add_css_class("fresh");
        let tile = tile.downgrade();
        glib::timeout_add_local_once(FRESH_FOR, move || {
            if let Some(tile) = tile.upgrade() {
                tile.remove_css_class("fresh");
            }
        });
    }
    tile.append(frame);
    tile.append(&label);
    tile
}

/// Shows "copied" over the preview for a moment.
fn flash(copied: &gtk::Box) {
    copied.add_css_class("shown");
    let copied = copied.downgrade();
    glib::timeout_add_local_once(COPIED_FOR, move || {
        if let Some(copied) = copied.upgrade() {
            copied.remove_css_class("shown");
        }
    });
}

/// Shows the file's thumbnail (or, for a picture, the picture itself), cut
/// to a square; otherwise its type's icon.
fn load_preview(
    file: &gio::File,
    preview: &gtk::Box,
    icon: &gtk::Image,
    content_type: &Rc<RefCell<Option<String>>>,
) {
    let (file, preview, icon, content_type) = (
        file.clone(),
        preview.clone(),
        icon.clone(),
        content_type.clone(),
    );
    glib::spawn_future_local(async move {
        let Ok(info) = file
            .query_info_future(
                "standard::content-type,standard::icon,thumbnail::path",
                gio::FileQueryInfoFlags::NONE,
                glib::Priority::LOW,
            )
            .await
        else {
            return; // gone; isled drops it on the next refresh
        };
        let kind = info.content_type().map(|kind| kind.to_string());
        content_type.replace(kind.clone());
        if let Some(gicon) = info.icon() {
            icon.set_from_gicon(&gicon);
        }

        let source = info
            .attribute_byte_string("thumbnail::path")
            .map(PathBuf::from)
            .or_else(|| {
                kind.as_deref()
                    .is_some_and(|kind| kind.starts_with("image/"))
                    .then(|| file.path())
                    .flatten()
            });
        let Some(source) = source else { return };
        let texture = gio::spawn_blocking(move || square_texture(&source)).await;
        if let Ok(Some(texture)) = texture {
            let picture = gtk::Image::builder()
                .paintable(&texture)
                .pixel_size(PREVIEW_SIZE)
                .hexpand(true)
                .build();
            preview.remove(&icon);
            preview.append(&picture);
            preview.add_css_class("thumbnail");
        }
    });
}

/// The middle square of the image at `path`, scaled to [`THUMBNAIL_PIXELS`].
/// Runs on a worker thread: big photos take a while to decode.
fn square_texture(path: &Path) -> Option<gdk::Texture> {
    let (_, width, height) = gdk_pixbuf::Pixbuf::file_info(path)?;
    if width <= 0 || height <= 0 {
        return None;
    }
    let side = THUMBNAIL_PIXELS;
    let scale = f64::from(side) / f64::from(width.min(height));
    let scaled_width = ((f64::from(width) * scale).round() as i32).max(side);
    let scaled_height = ((f64::from(height) * scale).round() as i32).max(side);
    let pixbuf =
        gdk_pixbuf::Pixbuf::from_file_at_scale(path, scaled_width, scaled_height, false).ok()?;
    let square = pixbuf
        .new_subpixbuf(
            (scaled_width - side) / 2,
            (scaled_height - side) / 2,
            side,
            side,
        )
        .copy()?;
    #[allow(deprecated)] // the replacement needs GTK 4.20
    Some(gdk::Texture::for_pixbuf(&square))
}

/// Copies the file: a picture as the image itself (what chats paste best), else as a file.
fn copy(file: &gio::File, content_type: Option<&str>, widget: &gtk::Widget) {
    let clipboard = widget.clipboard();
    let as_file = file_content(file);
    let picture = content_type.is_some_and(|kind| PICTURE_TYPES.contains(&kind));
    let Some(path) = file.path().filter(|_| picture) else {
        clipboard.set_content(Some(&as_file)).ok();
        return;
    };
    // A PNG is offered as its own bytes, never decoded. Other kinds are offered as PNG too, which
    // apps that take no other format need, so they go through a texture.
    if content_type == Some("image/png") {
        glib::spawn_future_local(async move {
            let content = match gio::spawn_blocking(move || std::fs::read(path)).await {
                Ok(Ok(png)) => {
                    gdk::ContentProvider::for_bytes("image/png", &glib::Bytes::from_owned(png))
                }
                _ => as_file,
            };
            clipboard.set_content(Some(&content)).ok();
        });
        return;
    }
    glib::spawn_future_local(async move {
        match gio::spawn_blocking(move || gdk::Texture::from_filename(path)).await {
            Ok(Ok(texture)) => clipboard.set_texture(&texture),
            _ => {
                clipboard.set_content(Some(&as_file)).ok();
            }
        }
    });
}

/// A file for the clipboard; no plain text, or text fields would paste its path.
fn file_content(file: &gio::File) -> gdk::ContentProvider {
    let uri = file.uri();
    gdk::ContentProvider::new_union(&[
        gdk::ContentProvider::for_bytes(
            "x-special/gnome-copied-files",
            &glib::Bytes::from_owned(format!("copy\n{uri}").into_bytes()),
        ),
        gdk::ContentProvider::for_bytes(
            "text/uri-list",
            &glib::Bytes::from_owned(format!("{uri}\r\n").into_bytes()),
        ),
    ])
}

/// Opens the file in its default app.
fn open(file: &gio::File, parent: Option<gtk::Window>) {
    let launcher = gtk::FileLauncher::new(Some(file));
    launcher.launch(parent.as_ref(), None::<&gio::Cancellable>, |result| {
        if let Err(err) = result {
            warn!("could not open the file: {err}");
        }
    });
}
