// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! "Call the bank tomorrow 17:00": a reminder's title and its local due time, read from one line.
//!
//! The time of day is [`crate::calendar::parse`]'s job ("Dinner 8:00 pm", "9:00-9:15"); this adds the day
//! words ("today", "tomorrow", "monday", "on 3 Nov") and the relative form ("in 10 min", "in 2h"). A line
//! with neither is a plain to-do.

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, Weekday};

use crate::calendar;

/// The hour a day word means when the line gives no time.
const TODAY_HOUR: u32 = 9;
const TOMORROW_HOUR: u32 = 9;
const TONIGHT_HOUR: u32 = 18;
const WEEKDAY_HOUR: u32 = 9;
const DATE_HOUR: u32 = 9;

/// A line read as a reminder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct When {
    pub title: String,
    /// In the local wall clock; `None` for a plain to-do.
    pub at: Option<NaiveDateTime>,
}

/// What named the day, to settle one already behind us.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// "today", "tomorrow", "tonight": kept as it is, even when late.
    Plain,
    /// "monday": the next one.
    Weekday,
    /// "3 Nov": this year, or the next when it has passed.
    Date,
}

/// Reads `line` as a reminder due at or after `now` (also local).
pub fn parse(line: &str, now: NaiveDateTime) -> When {
    let words: Vec<&str> = line.split_whitespace().collect();
    let lower: Vec<String> = words.iter().map(|word| word.to_lowercase()).collect();
    let mut used = vec![false; words.len()];

    // "in 10 minutes", "in 2h", "in 90 min": a delay from now, no day involved.
    if let Some((from, to, at)) = relative(&lower, now) {
        used[from..to].iter_mut().for_each(|word| *word = true);
        return When { title: title(&words, &used), at: Some(at) };
    }

    let day = day(&lower, now);
    if let Some((from, to, ..)) = day {
        used[from..to].iter_mut().for_each(|word| *word = true);
    }

    // What is left holds the title and, if it has one, the time of day.
    let rest = join(&words, &used);
    let parsed = calendar::parse(&rest);
    let minutes = parsed.as_ref().and_then(|parsed| parsed.start);
    let title = parsed.map(|parsed| parsed.title).unwrap_or(rest);

    let at = match (day, minutes) {
        (Some((_, _, date, hour, kind)), minutes) => {
            let mut at = at_time(date, minutes.unwrap_or(hour * 60));
            match kind {
                Kind::Weekday if at <= now => at += Duration::days(7),
                Kind::Date if at <= now => {
                    at = at
                        .with_year(at.year() + 1)
                        .unwrap_or_else(|| at + Duration::days(365));
                }
                _ => {}
            }
            Some(at)
        }
        (None, Some(minutes)) => {
            let today = at_time(now.date(), minutes);
            // A time already past today means tomorrow.
            Some(if today <= now { today + Duration::days(1) } else { today })
        }
        (None, None) => None,
    };
    When { title, at }
}

/// The date, the words that named it, the hour it means on its own, and what kind it is.
fn day(words: &[String], now: NaiveDateTime) -> Option<(usize, usize, NaiveDate, u32, Kind)> {
    let today = now.date();
    for (i, word) in words.iter().enumerate() {
        match word.as_str() {
            "today" => return Some((i, i + 1, today, TODAY_HOUR, Kind::Plain)),
            "tonight" => return Some((i, i + 1, today, TONIGHT_HOUR, Kind::Plain)),
            "tomorrow" => {
                let date = today + Duration::days(1);
                return Some((i, i + 1, date, TOMORROW_HOUR, Kind::Plain));
            }
            _ => {}
        }
        if let Some(weekday) = weekday(word) {
            let date = next_weekday(today, weekday);
            return Some((i, i + 1, date, WEEKDAY_HOUR, Kind::Weekday));
        }
        // "on 3 Nov", "3 Nov", "Nov 3": the month either side of the day.
        if let Some((from, to, date)) = date_at(words, i, today) {
            let from = if i > 0 && words[i - 1] == "on" { i - 1 } else { from };
            return Some((from, to, date, DATE_HOUR, Kind::Date));
        }
    }
    None
}

/// "3 nov", "3rd november", "nov 3": a day of a month.
fn date_at(words: &[String], i: usize, today: NaiveDate) -> Option<(usize, usize, NaiveDate)> {
    let day = |word: &str| -> Option<u32> {
        let digits: String = word.chars().take_while(char::is_ascii_digit).collect();
        let day: u32 = digits.parse().ok()?;
        (1..=31).contains(&day).then_some(day)
    };
    let (day, month) = match (day(&words[i]), words.get(i + 1).and_then(|word| month(word))) {
        (Some(day), Some(month)) => (day, month),
        _ => (day(words.get(i + 1)?)?, month(&words[i])?),
    };
    let date = NaiveDate::from_ymd_opt(today.year(), month, day)?;
    Some((i, i + 2, date))
}

/// The month a word names, 1-12.
fn month(word: &str) -> Option<u32> {
    Some(match word {
        "jan" | "january" => 1,
        "feb" | "february" => 2,
        "mar" | "march" => 3,
        "apr" | "april" => 4,
        "may" => 5,
        "jun" | "june" => 6,
        "jul" | "july" => 7,
        "aug" | "august" => 8,
        "sep" | "sept" | "september" => 9,
        "oct" | "october" => 10,
        "nov" | "november" => 11,
        "dec" | "december" => 12,
        _ => return None,
    })
}

/// The weekday a word names, short or long.
fn weekday(word: &str) -> Option<Weekday> {
    Some(match word {
        "monday" | "mon" => Weekday::Mon,
        "tuesday" | "tue" | "tues" => Weekday::Tue,
        "wednesday" | "wed" => Weekday::Wed,
        "thursday" | "thu" | "thur" | "thurs" => Weekday::Thu,
        "friday" | "fri" => Weekday::Fri,
        "saturday" | "sat" => Weekday::Sat,
        "sunday" | "sun" => Weekday::Sun,
        _ => return None,
    })
}

/// The first `weekday` on or after `today`.
fn next_weekday(today: NaiveDate, weekday: Weekday) -> NaiveDate {
    let days = weekday.num_days_from_monday() as i64 - today.weekday().num_days_from_monday() as i64;
    today + Duration::days(days.rem_euclid(7))
}

/// "in 10 min", "in 2h", "in 90 minutes": a delay from `now`.
fn relative(words: &[String], now: NaiveDateTime) -> Option<(usize, usize, NaiveDateTime)> {
    for i in 0..words.len() {
        if words[i] != "in" {
            continue;
        }
        let digits: String = words
            .get(i + 1)?
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        let count: i64 = digits.parse().ok()?;
        let unit = words.get(i + 2)?;
        let minutes = if unit.starts_with('h') {
            count * 60
        } else if unit.starts_with('m') {
            count
        } else {
            return None;
        };
        return Some((i, i + 3, now + Duration::minutes(minutes)));
    }
    None
}

/// `date` at `minutes` after midnight.
fn at_time(date: NaiveDate, minutes: u32) -> NaiveDateTime {
    let time =
        NaiveTime::from_num_seconds_from_midnight_opt(minutes * 60, 0).unwrap_or(NaiveTime::MIN);
    NaiveDateTime::new(date, time)
}

/// The words no rule took, as the title.
fn join(words: &[&str], used: &[bool]) -> String {
    words
        .iter()
        .zip(used)
        .filter(|(_, used)| !**used)
        .map(|(word, _)| *word)
        .collect::<Vec<_>>()
        .join(" ")
}

/// The title, without the "to" or "for" a delay left behind ("in 10 min to call the bank").
fn title(words: &[&str], used: &[bool]) -> String {
    let title = join(words, used);
    let title = title.trim_matches(|c: char| c == ',' || c == '-' || c.is_whitespace());
    for lead in ["to ", "for "] {
        if let Some(rest) = title.strip_prefix(lead) {
            return rest.trim().to_owned();
        }
    }
    title.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Saturday, 10:00.
    fn now() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 10, 31)
            .unwrap()
            .and_hms_opt(10, 0, 0)
            .unwrap()
    }

    fn when(line: &str) -> (String, Option<String>) {
        let when = parse(line, now());
        (when.title, when.at.map(|at| at.format("%Y-%m-%d %H:%M").to_string()))
    }

    #[test]
    fn a_day_word_and_a_time() {
        assert_eq!(
            when("Call the bank tomorrow 17:00"),
            ("Call the bank".into(), Some("2026-11-01 17:00".into()))
        );
        assert_eq!(
            when("Standup monday 9:00"),
            ("Standup".into(), Some("2026-11-02 09:00".into()))
        );
    }

    #[test]
    fn a_time_alone_is_today_unless_it_has_passed() {
        assert_eq!(
            when("Call the bank 17:00"),
            ("Call the bank".into(), Some("2026-10-31 17:00".into()))
        );
        assert_eq!(
            when("Call the bank 09:00"),
            ("Call the bank".into(), Some("2026-11-01 09:00".into()))
        );
    }

    #[test]
    fn a_day_word_alone_has_an_hour() {
        assert_eq!(
            when("Pay rent tomorrow"),
            ("Pay rent".into(), Some("2026-11-01 09:00".into()))
        );
        assert_eq!(
            when("Dinner tonight"),
            ("Dinner".into(), Some("2026-10-31 18:00".into()))
        );
    }

    #[test]
    fn a_weekday_already_past_means_the_next_one() {
        assert_eq!(
            when("Gym saturday 09:00"),
            ("Gym".into(), Some("2026-11-07 09:00".into()))
        );
        assert_eq!(
            when("Gym saturday 18:00"),
            ("Gym".into(), Some("2026-10-31 18:00".into()))
        );
    }

    #[test]
    fn a_date_is_this_year_unless_it_has_passed() {
        assert_eq!(
            when("Pay rent on 3 Nov"),
            ("Pay rent".into(), Some("2026-11-03 09:00".into()))
        );
        assert_eq!(
            when("Renew 3 November"),
            ("Renew".into(), Some("2026-11-03 09:00".into()))
        );
        assert_eq!(
            when("Renew on 3 Oct"),
            ("Renew".into(), Some("2027-10-03 09:00".into()))
        );
    }

    #[test]
    fn a_delay_from_now() {
        assert_eq!(
            when("Call the bank in 10 min"),
            ("Call the bank".into(), Some("2026-10-31 10:10".into()))
        );
        assert_eq!(
            when("Take the cake out in 2 hours"),
            ("Take the cake out".into(), Some("2026-10-31 12:00".into()))
        );
        assert_eq!(
            when("in 90 minutes to stretch"),
            ("stretch".into(), Some("2026-10-31 11:30".into()))
        );
    }

    #[test]
    fn no_time_is_a_plain_todo() {
        assert_eq!(when("Water the plants"), ("Water the plants".into(), None));
        assert_eq!(when("Buy 2 apples"), ("Buy 2 apples".into(), None));
    }

    #[test]
    fn a_range_keeps_its_start() {
        assert_eq!(
            when("Dinner 20:00-21:00 tomorrow"),
            ("Dinner".into(), Some("2026-11-01 20:00".into()))
        );
    }
}
