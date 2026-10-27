// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

use isle_core::calendar::{AddError, Calendar};
use zbus::object_server::SignalEmitter;
use zbus::{fdo, interface};

use crate::clock::today;
use crate::meeting::MeetingLinks;
use crate::store::Store;

/// Longest calendar or event id `MeetingLink` takes.
const MAX_UID: usize = 1024;

/// The D-Bus calendar: Isle's own events, saved to disk, plus meeting links of desktop events.
pub struct CalendarService {
    calendar: Calendar,
    store: Store<Calendar>,
    links: MeetingLinks,
}

impl CalendarService {
    /// Loads the saved events, dropping past ones.
    pub fn load() -> Self {
        let mut store = Store::new("calendar");
        let mut calendar: Calendar = store.load();
        if calendar.forget_old(&today()) {
            store.save(&calendar);
        }
        Self {
            calendar,
            store,
            links: MeetingLinks::default(),
        }
    }

    /// The events, for the assistant and the agenda.
    pub fn calendar(&self) -> &Calendar {
        &self.calendar
    }

    /// Saves the events and tells the extension they changed.
    async fn changed(&self, emitter: &SignalEmitter<'_>) -> zbus::Result<()> {
        self.store.save(&self.calendar);
        self.events_changed(emitter).await
    }
}

#[interface(name = "io.github.zickrian.isle.Calendar1")]
impl CalendarService {
    /// Adds an event on `date` ("YYYY-MM-DD") from a line of text such as
    /// "Lunch 12:30" or "Standup 9:00-9:15"; returns its id.
    async fn add(
        &mut self,
        date: &str,
        text: &str,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<u64> {
        let id = self.calendar.add(date, text).map_err(|err| {
            fdo::Error::InvalidArgs(match err {
                AddError::BadDate => format!("`{date}` is not a date (YYYY-MM-DD)"),
                AddError::NoTitle => "an event needs a title".into(),
            })
        })?;
        self.calendar.forget_old(&today());
        self.changed(&emitter).await?;
        Ok(id)
    }

    /// Deletes one of Isle's own events.
    async fn remove(
        &mut self,
        id: u64,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        if !self.calendar.remove(id) {
            return Err(fdo::Error::InvalidArgs(format!("no event with id {id}")));
        }
        Ok(self.changed(&emitter).await?)
    }

    /// The meeting link (Meet, Zoom, Teams, Webex) of a desktop calendar's event, or "".
    /// Calls here wait for a lookup in Evolution Data Server, at most a few seconds.
    async fn meeting_link(
        &self,
        source_uid: &str,
        event_uid: &str,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> fdo::Result<String> {
        let fits = |uid: &str| !uid.is_empty() && uid.len() <= MAX_UID;
        if !fits(source_uid) || !fits(event_uid) {
            return Err(fdo::Error::InvalidArgs(
                "a calendar and an event id are needed".into(),
            ));
        }
        Ok(self.links.get(connection, source_uid, event_uid).await)
    }

    /// JSON array of `Event`, by day and start time.
    #[zbus(property)]
    fn events(&self) -> String {
        serde_json::to_string(self.calendar.events()).unwrap_or_default()
    }
}
