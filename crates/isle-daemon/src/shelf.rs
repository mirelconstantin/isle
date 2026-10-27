// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

use isle_core::shelf::{CAPACITY, Shelf, ShelfItem};
use zbus::object_server::SignalEmitter;
use zbus::{fdo, interface};

use crate::clock::now_ms;
use crate::store::{Store, data_dir};
use crate::uri;

/// The file shelf on the bus, saved to disk after every change.
pub struct ShelfService {
    shelf: Shelf,
    store: Store<Shelf>,
}

impl ShelfService {
    /// Loads the saved shelf, dropping files gone since and copies no longer listed.
    pub fn load() -> Self {
        let mut store = Store::new("shelf");
        let mut shelf: Shelf = store.load();
        // Files may have been moved or deleted while Isle was not running.
        if shelf.retain_existing(|item| file_exists(&item.uri)) {
            store.save(&shelf);
        }
        if !store.lost_track() {
            remove_unlisted_copies(&shelf);
        }
        Self { shelf, store }
    }

    /// Saves the shelf and tells the extension.
    async fn changed(&self, emitter: &SignalEmitter<'_>) -> zbus::Result<()> {
        self.store.save(&self.shelf);
        self.items_changed(emitter).await
    }
}

#[interface(name = "io.github.zickrian.isle.Shelf1")]
impl ShelfService {
    /// Adds local files by `file://` URI. Other URIs are rejected without stopping the rest;
    /// the call then fails as invalid, naming the rejected URIs.
    async fn add(
        &mut self,
        uris: Vec<String>,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        let mut rejected = Vec::new();
        let mut full = Vec::new();
        let mut added = false;
        for uri in uris {
            let Some(path) = uri::to_path(&uri) else {
                rejected.push(uri);
                continue;
            };
            let name = path
                .file_name()
                .map_or_else(|| uri.clone(), |name| name.to_string_lossy().into_owned());
            let item = ShelfItem {
                uri: uri.clone(),
                name,
                added_at_ms: now_ms(),
            };
            if self.shelf.add(item) {
                added = true;
            } else {
                full.push(uri);
            }
        }
        if added {
            self.changed(&emitter).await?;
        }
        if !full.is_empty() {
            return Err(fdo::Error::LimitsExceeded(format!(
                "the shelf holds {CAPACITY} files; remove one to add {}",
                full.join(" ")
            )));
        }
        if rejected.is_empty() {
            Ok(())
        } else {
            Err(fdo::Error::InvalidArgs(format!(
                "not local files: {}",
                rejected.join(" ")
            )))
        }
    }

    /// Takes one file off the shelf, deleting it only if it is the shelf's own copy.
    async fn remove(
        &mut self,
        uri: &str,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        if self.shelf.remove(uri) {
            forget(uri);
            self.changed(&emitter).await?;
        }
        Ok(())
    }

    /// Empties the shelf, deleting the shelf's own copies.
    async fn clear(
        &mut self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        for item in self.shelf.items() {
            forget(&item.uri);
        }
        self.shelf.clear();
        Ok(self.changed(&emitter).await?)
    }

    /// Drops items whose files no longer exist.
    async fn refresh(
        &mut self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        if self.shelf.retain_existing(|item| file_exists(&item.uri)) {
            self.changed(&emitter).await?;
        }
        Ok(())
    }

    /// JSON array of `ShelfItem`, newest first.
    #[zbus(property)]
    fn items(&self) -> String {
        serde_json::to_string(self.shelf.items()).unwrap_or_default()
    }
}

/// Deletes the shelf's own copy of a clipboard image (kept so it outlives the history).
/// The user's own files are never touched.
fn forget(uri: &str) {
    let Some(path) = uri::to_path(uri) else {
        return;
    };
    if is_copy(&path, &owned_dir())
        && let Err(err) = std::fs::remove_file(&path)
    {
        log::debug!("could not remove {}: {err}", path.display());
    }
}

/// Deletes copies in the shelf's folder that are no longer on the shelf
/// (taken off while isled was not running, or refused because it was full).
fn remove_unlisted_copies(shelf: &Shelf) {
    let Ok(entries) = std::fs::read_dir(owned_dir()) else {
        return;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        let listed = shelf
            .items()
            .iter()
            .any(|item| uri::to_path(&item.uri).as_ref() == Some(&path));
        if !listed && let Err(err) = std::fs::remove_file(&path) {
            log::debug!("could not remove {}: {err}", path.display());
        }
    }
}

/// Whether `path` is a file right in the shelf's folder; `shelf/../x` is not, as any bus client may add it.
fn is_copy(path: &std::path::Path, dir: &std::path::Path) -> bool {
    path.parent() == Some(dir) && path.file_name().is_some()
}

/// Where copies made for the shelf live: `~/.local/share/isle/shelf`.
fn owned_dir() -> std::path::PathBuf {
    data_dir().join("shelf")
}

/// Whether a `file://` URI still points at something on disk.
fn file_exists(uri: &str) -> bool {
    uri::to_path(uri).is_some_and(|path| path.exists())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn deletes_only_its_own_copies() {
        let dir = Path::new("/home/a/.local/share/isle/shelf");
        assert!(is_copy(&dir.join("Clipboard image.png"), dir));
        for path in [
            "/home/a/.local/share/isle/shelf/../../Documents/x",
            "/home/a/.local/share/isle/shelf/..",
            "/home/a/.local/share/isle/shelf/sub/x",
            "/home/a/Documents/x",
        ] {
            assert!(!is_copy(Path::new(path), dir), "{path}");
        }
        let uri = "file:///home/a/.local/share/isle/shelf/../../Documents/x";
        assert!(!is_copy(&uri::to_path(uri).unwrap(), dir));
    }
}
