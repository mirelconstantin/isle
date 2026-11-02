// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

use std::sync::Arc;

use chrono::{Duration, Local, NaiveDateTime, TimeZone, Timelike};
use isle_core::todo::TodoList;
use isle_core::when;
use log::warn;
use tokio::sync::Notify;
use zbus::object_server::{InterfaceRef, SignalEmitter};
use zbus::{fdo, interface};

use crate::clock::{next_midnight, now_ms, start_of_today, wait_until};
use crate::store::{Store, data_dir};

/// The furthest a reminder may be set ahead: a year.
const MAX_AHEAD_MS: i64 = 366 * 24 * 60 * 60 * 1000;

/// The to-do list on the bus, saved to disk after every change.
pub struct TodoService {
    list: TodoList,
    store: Store<TodoList>,
    wake: Arc<Notify>,
}

impl TodoService {
    /// Loads the saved list, dropping tasks finished before today and folding in the timed reminders the
    /// assistant used to keep apart (`reminders.json`).
    pub fn load() -> Self {
        let mut store = Store::new("todo");
        let mut list: TodoList = store.load();
        let dropped = list.drop_done_before(start_of_today());
        let folded = adopt_reminders(&mut list, &data_dir().join("reminders.json"));
        if dropped || folded {
            store.save(&list);
        }
        Self {
            list,
            store,
            wake: Arc::default(),
        }
    }

    /// The current list, for the assistant to read.
    pub fn list(&self) -> &TodoList {
        &self.list
    }

    /// Saves the list, rearms the midnight wait and tells the extension.
    async fn changed(&self, emitter: &SignalEmitter<'_>) -> zbus::Result<()> {
        self.store.save(&self.list);
        self.wake.notify_one();
        self.items_changed(emitter).await
    }
}

/// A due time from the bus: 0 is none, and nothing is more than a year away.
fn due_from(due_ms: i64) -> fdo::Result<Option<i64>> {
    if due_ms <= 0 {
        return Ok(None);
    }
    if due_ms - now_ms() > MAX_AHEAD_MS {
        return Err(fdo::Error::InvalidArgs(
            "a reminder is at most a year away".into(),
        ));
    }
    Ok(Some(due_ms))
}

/// Epoch milliseconds for a local wall-clock time; one in a DST gap moves an hour on.
fn epoch_ms(at: NaiveDateTime) -> i64 {
    let later = at + Duration::hours(1);
    Local
        .from_local_datetime(&at)
        .earliest()
        .or_else(|| Local.from_local_datetime(&later).earliest())
        .map(|at| at.timestamp_millis())
        .unwrap_or_else(|| at.and_utc().timestamp_millis())
}

/// Folds `reminders.json` (what `Reminders1` kept) into the list, once, and moves the file aside.
fn adopt_reminders(list: &mut TodoList, path: &std::path::Path) -> bool {
    /// The old file's shape; only what is needed to keep the reminders.
    #[derive(serde::Deserialize)]
    struct Old {
        items: Vec<OldReminder>,
    }
    #[derive(serde::Deserialize)]
    struct OldReminder {
        text: String,
        due_ms: i64,
    }

    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    let Ok(old) = serde_json::from_slice::<Old>(&bytes) else {
        warn!(
            "could not read {}; the timed reminders were left as they are",
            path.display()
        );
        return false;
    };
    for reminder in old.items {
        list.add(&reminder.text, Some(reminder.due_ms));
    }
    // Kept aside rather than deleted: nothing is lost if the fold was wrong. Moved or emptied either way,
    // so the next start does not fold the same reminders in twice.
    if let Err(err) = std::fs::rename(path, path.with_extension("json.migrated")) {
        warn!(
            "could not move {} aside: {err}; emptying it instead",
            path.display()
        );
        if let Err(err) = std::fs::write(path, br#"{"items":[],"next_id":0}"#) {
            warn!("could not empty {}: {err}", path.display());
        }
    }
    true
}

/// The error for a task id that is not on the list.
fn not_found(id: u64) -> fdo::Error {
    fdo::Error::InvalidArgs(format!("no task with id {id}"))
}

/// The rule a bus string names: empty is none, and anything else must be one Isle knows.
fn repeat_from(repeat: &str) -> fdo::Result<Option<&'static str>> {
    if repeat.trim().is_empty() {
        return Ok(None);
    }
    when::Repeat::parse(repeat)
        .map(|rule| Some(rule.as_str()))
        .ok_or_else(|| fdo::Error::InvalidArgs(format!("`{repeat}` is not a repeat Isle knows")))
}

/// Local wall-clock time for epoch milliseconds.
fn naive_of(ms: i64) -> Option<NaiveDateTime> {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|at| at.naive_local())
}

/// Moves a repeating task on to its next occurrence, past both its due time and `now`, and lets its alert
/// show again; false when the task does not repeat. A task ticked early moves a whole period on.
fn roll_forward(list: &mut TodoList, id: u64, now: i64) -> bool {
    let Some(item) = list.get(id) else {
        return false;
    };
    let Some(rule) = item.repeat.as_deref().and_then(when::Repeat::parse) else {
        return false;
    };
    let Some(due) = item.due_ms else {
        return false;
    };
    let Some(due_at) = naive_of(due) else {
        return false;
    };
    let minutes = due_at.hour() * 60 + due_at.minute();
    let base = naive_of(due.max(now)).unwrap_or(due_at);
    list.set_due(id, Some(epoch_ms(rule.next(base, minutes))))
}

#[interface(name = "io.github.zickrian.isle.Todo1")]
impl TodoService {
    /// Adds a task due at `due_ms` (0 for none) that comes back as `repeat` says ("day", "weekday",
    /// "mon"…"sun"; empty for one that doesn't), and returns its id.
    async fn add(
        &mut self,
        text: &str,
        due_ms: i64,
        repeat: &str,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<u64> {
        let due = due_from(due_ms)?;
        let repeat = repeat_from(repeat)?;
        let id = self
            .list
            .add(text, due)
            .ok_or_else(|| fdo::Error::InvalidArgs("a task needs a title".into()))?;
        if let Some(repeat) = repeat {
            self.list.set_repeat(id, Some(repeat));
        }
        self.changed(&emitter).await?;
        Ok(id)
    }

    /// Sets when a task is due (`due_ms` 0 clears it), as a snooze or a changed time does.
    async fn set_due(
        &mut self,
        id: u64,
        due_ms: i64,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        let due = due_from(due_ms)?;
        if !self.list.set_due(id, due) {
            return Err(not_found(id));
        }
        Ok(self.changed(&emitter).await?)
    }

    /// Sets how a task comes back once it is done ("day", "weekday", "mon"…"sun"; empty stops it).
    async fn set_repeat(
        &mut self,
        id: u64,
        repeat: &str,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        let repeat = repeat_from(repeat)?;
        if !self.list.set_repeat(id, repeat) {
            return Err(not_found(id));
        }
        Ok(self.changed(&emitter).await?)
    }

    /// Reads a line as a reminder: `{title, due_ms, repeat}` (`due_ms` 0 when it has no time, `repeat` ""
    /// when it does not come back), as the Reminders page and the assistant read it.
    async fn parse(&self, text: &str) -> fdo::Result<String> {
        let when = when::parse(text, Local::now().naive_local());
        if when.title.trim().is_empty() {
            return Err(fdo::Error::InvalidArgs("a reminder needs a title".into()));
        }
        let due = when.at.map(epoch_ms).unwrap_or(0);
        let repeat = when.repeat.map(|rule| rule.as_str()).unwrap_or_default();
        Ok(serde_json::json!({"title": when.title, "due_ms": due, "repeat": repeat}).to_string())
    }

    /// Notes that a task's due alert was shown (`alerted` false puts it back in line for one). A repeating
    /// task keeps its time until it is ticked off: its next one is counted from there (see `set_done`).
    async fn set_alerted(
        &mut self,
        id: u64,
        alerted: bool,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        if !self.list.set_alerted(id, alerted) {
            return Err(not_found(id));
        }
        Ok(self.changed(&emitter).await?)
    }

    /// Ticks a task off, or back on. A repeating one is never finished: ticking it moves it on to its next
    /// occurrence instead, so the list keeps it.
    async fn set_done(
        &mut self,
        id: u64,
        done: bool,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        if done && roll_forward(&mut self.list, id, now_ms()) {
            return Ok(self.changed(&emitter).await?);
        }
        if !self.list.set_done(id, done, now_ms()) {
            return Err(not_found(id));
        }
        Ok(self.changed(&emitter).await?)
    }

    /// Renames a task; a blank title is refused.
    async fn rename(
        &mut self,
        id: u64,
        title: &str,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        if !self.list.rename(id, title) {
            return Err(fdo::Error::InvalidArgs(format!(
                "cannot rename task {id} to `{title}`"
            )));
        }
        Ok(self.changed(&emitter).await?)
    }

    /// Deletes a task.
    async fn remove(
        &mut self,
        id: u64,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        if !self.list.remove(id) {
            return Err(not_found(id));
        }
        Ok(self.changed(&emitter).await?)
    }

    /// Deletes every finished task.
    async fn clear_done(
        &mut self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        self.list.clear_done();
        Ok(self.changed(&emitter).await?)
    }

    /// JSON array of `TodoItem`.
    #[zbus(property)]
    fn items(&self) -> String {
        serde_json::to_string(self.list.items()).unwrap_or_default()
    }
}

/// Clears yesterday's finished tasks at midnight.
pub async fn run(iface: InterfaceRef<TodoService>) {
    let wake = iface.get().await.wake.clone();
    loop {
        if !wait_until(next_midnight(), &wake).await {
            continue;
        }
        let mut service = iface.get_mut().await;
        if !service.list.drop_done_before(start_of_today()) {
            continue;
        }
        if let Err(err) = service.changed(iface.signal_emitter()).await {
            warn!("could not clear yesterday's tasks: {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file of its own, so tests do not share one.
    fn path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("isle-todo-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("reminders.json")
    }

    #[test]
    fn the_old_reminders_are_folded_in_once() {
        let path = path("fold");
        std::fs::write(&path, r#"{"items":[{"id":1,"text":"Tea","due_ms":1000},{"id":2,"text":"Bank","due_ms":2000}],"next_id":2}"#).unwrap();
        let mut list = TodoList::default();
        assert!(adopt_reminders(&mut list, &path));
        let titles: Vec<_> = list
            .items()
            .iter()
            .map(|item| item.title.as_str())
            .collect();
        assert_eq!(titles, ["Tea", "Bank"]);
        assert_eq!(list.items()[0].due_ms, Some(1000));
        // The file is out of the way, so a second start does not add them again.
        assert!(!path.exists());
        assert!(!adopt_reminders(&mut list, &path));
        assert_eq!(list.items().len(), 2);
    }

    /// A local wall-clock time as epoch milliseconds, the way a due time is kept.
    fn at(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
        epoch_ms(
            chrono::NaiveDate::from_ymd_opt(year, month, day)
                .unwrap()
                .and_hms_opt(hour, minute, 0)
                .unwrap(),
        )
    }

    #[test]
    fn a_repeat_only_takes_a_rule_isle_knows() {
        assert_eq!(repeat_from("").unwrap(), None);
        assert_eq!(repeat_from("mon").unwrap(), Some("mon"));
        assert_eq!(repeat_from("weekday").unwrap(), Some("weekday"));
        assert!(repeat_from("fortnightly").is_err());
    }

    #[test]
    fn ticking_a_repeating_reminder_moves_it_on() {
        // Monday 2 November 2026, 09:00, weekly; ticked that afternoon.
        let due = at(2026, 11, 2, 9, 0);
        let now = at(2026, 11, 2, 15, 0);
        let mut list = TodoList::default();
        let id = list.add("Gym", Some(due)).unwrap();
        assert!(list.set_repeat(id, Some("mon")));
        assert!(roll_forward(&mut list, id, now));
        // The next Monday, at the same hour, and its alert can show again.
        assert_eq!(list.items()[0].due_ms, Some(at(2026, 11, 9, 9, 0)));
        assert!(!list.items()[0].alerted);
    }

    #[test]
    fn a_stale_daily_reminder_moves_to_the_next_one_ahead() {
        // Three days late: the next one is tomorrow, not the day after the one it missed.
        let due = at(2026, 11, 2, 9, 0);
        let now = at(2026, 11, 5, 12, 0);
        let mut list = TodoList::default();
        let id = list.add("Vitamins", Some(due)).unwrap();
        assert!(list.set_repeat(id, Some("day")));
        assert!(roll_forward(&mut list, id, now));
        assert_eq!(list.items()[0].due_ms, Some(at(2026, 11, 6, 9, 0)));
    }

    #[test]
    fn a_weekday_repeat_skips_the_weekend() {
        // Friday 6 November 2026, ticked; the next weekday is Monday the 9th.
        let due = at(2026, 11, 6, 9, 0);
        let mut list = TodoList::default();
        let id = list.add("Standup", Some(due)).unwrap();
        assert!(list.set_repeat(id, Some("weekday")));
        assert!(roll_forward(&mut list, id, due));
        assert_eq!(list.items()[0].due_ms, Some(at(2026, 11, 9, 9, 0)));
    }

    #[test]
    fn a_task_that_does_not_repeat_stays_where_it_is() {
        let due = at(2026, 11, 2, 9, 0);
        let mut list = TodoList::default();
        let id = list.add("Call the bank", Some(due)).unwrap();
        assert!(!roll_forward(&mut list, id, at(2026, 11, 3, 9, 0)));
        assert_eq!(list.items()[0].due_ms, Some(due));
        assert!(!roll_forward(&mut list, id + 1, due));
    }

    #[test]
    fn no_old_file_changes_nothing() {
        let mut list = TodoList::default();
        assert!(!adopt_reminders(&mut list, &path("none")));
        assert!(list.items().is_empty());
    }
}
