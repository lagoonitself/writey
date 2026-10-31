//! Writey hearing itself. Through speakers the mic picks up Writey's own voice; there is no
//! browser echo canceller in a desktop app. Half-duplex gating drops mic audio while the
//! speaker is live (plus a short tail), except barge-in phrases. A normalized fuzzy match
//! against recent spoken lines is a second line of defence.

use std::collections::{HashSet, VecDeque};
use std::time::{Duration, Instant};

use super::text::number_words;

/// After the output buffer drains, room echo can still reach the mic.
const TAIL: Duration = Duration::from_millis(700);
/// Spoken lines to compare heard text against.
const ECHO_WINDOW: Duration = Duration::from_secs(15);

const WAKE: &[&str] = &["hey", "hay", "heya", "heyy"];
const NAME: &[&str] = &[
    "writey", "writy", "writie", "wrytey", "wrighty", "righty", "rightie", "rightey", "ritey",
    "ritie", "rytey", "raity", "reitey", "rioty", "riety", "reity", "righti", "writi", "ridey",
    "ridy", "rydey",
];

#[derive(Default)]
pub struct EchoGuard {
    said: VecDeque<(Instant, Vec<String>)>,
    /// True while the cpal output buffer has samples (updated from the speaker thread).
    output_live: bool,
    /// When the output buffer last went empty while something had been playing.
    quiet_since: Option<Instant>,
}

fn words(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
        .collect()
}

/// Normalized tokens for echo compare (punctuation stripped, digits as spoken words).
pub fn normalize_tokens(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    for w in words(s) {
        if w.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(n) = w.parse::<u64>() {
                out.extend(words(&number_words(n)));
                continue;
            }
        }
        out.push(w);
    }
    out
}

fn fuzzy_echo(heard: &[String], said: &[String]) -> bool {
    if heard.is_empty() {
        return true;
    }
    if said.is_empty() {
        return false;
    }
    let said_set: HashSet<&String> = said.iter().collect();
    let hits = heard.iter().filter(|w| said_set.contains(w)).count();
    if hits * 10 >= heard.len() * 6 {
        return true;
    }
    // Long partial repeats: heard words appear in order inside what Writey said.
    let mut j = 0;
    for h in heard {
        while j < said.len() && &said[j] != h {
            j += 1;
        }
        if j >= said.len() {
            return false;
        }
        j += 1;
    }
    heard.len() >= 3
}

impl EchoGuard {
    pub fn said(&mut self, text: &str) {
        let now = Instant::now();
        self.said
            .retain(|(t, _)| now.duration_since(*t) < ECHO_WINDOW);
        self.said.push_back((now, normalize_tokens(text)));
    }

    /// Called from the speaker thread when the output buffer has or lacks samples.
    pub fn sync_output_buffer(&mut self, has_samples: bool) {
        if has_samples {
            self.output_live = true;
            self.quiet_since = None;
        } else if self.output_live {
            self.output_live = false;
            self.quiet_since = Some(Instant::now());
        }
    }

    /// Playback stopped abruptly (user said "stop").
    pub fn flush_output(&mut self) {
        self.output_live = false;
        self.quiet_since = Some(Instant::now());
    }

    /// Do not run normal VAD/STT on the mic (half-duplex), except barge-in handling.
    pub fn mic_gated(&self) -> bool {
        self.output_live || self.quiet_since.is_some_and(|t| t.elapsed() < TAIL)
    }

    /// Writey spoke just now, so a heard line may still carry its voice.
    pub fn recently_live(&self, within: Duration) -> bool {
        self.output_live || self.quiet_since.is_some_and(|t| t.elapsed() < within)
    }

    /// Speaker still playing or within the post-playback tail.
    pub fn playback_live(&self) -> bool {
        self.mic_gated()
    }

    /// A heard line that mostly repeats what Writey said recently.
    pub fn is_echo(&self, heard: &str) -> bool {
        let heard = normalize_tokens(heard);
        if heard.is_empty() {
            return true;
        }
        let now = Instant::now();
        for (t, said) in &self.said {
            if now.duration_since(*t) > ECHO_WINDOW {
                continue;
            }
            if fuzzy_echo(&heard, said) {
                return true;
            }
        }
        false
    }

    /// Short interruption while Writey is speaking: "stop", "Hey …", or the name alone.
    pub fn is_barge_in(heard: &str) -> bool {
        let w = words(heard);
        if w.is_empty() {
            return false;
        }
        if w.len() <= 5 && is_stopish(&w) {
            return true;
        }
        if WAKE.contains(&w[0].as_str()) {
            return true;
        }
        if NAME.contains(&w[0].as_str()) {
            return true;
        }
        false
    }
}

fn is_stopish(w: &[String]) -> bool {
    let s = w.join(" ");
    s.starts_with("stop")
        || s.starts_with("stopped")
        || s.starts_with("be quiet")
        || s.starts_with("shut up")
        || s.starts_with("cancel")
        || s.starts_with("never mind")
        || s.starts_with("nevermind")
        || s.starts_with("quiet")
        || s.starts_with("wait")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gates_mic_while_output_live_and_tail() {
        let mut g = EchoGuard::default();
        assert!(!g.mic_gated());
        g.sync_output_buffer(true);
        assert!(g.mic_gated());
        g.sync_output_buffer(false);
        assert!(g.mic_gated());
    }

    #[test]
    fn drops_its_own_voice_but_not_interruptions() {
        let mut g = EchoGuard::default();
        g.said("Integrate by parts, with u equal to x.");
        g.sync_output_buffer(true);
        assert!(g.is_echo("integrate by parts with u equal"));
        assert!(!g.is_echo("stop"));
        assert!(!g.is_echo("wait what's u"));
        g.sync_output_buffer(false);
        assert!(EchoGuard::is_barge_in("stop"));
        assert!(EchoGuard::is_barge_in("hey writey pause"));
    }

    #[test]
    fn normalizes_digits_for_echo() {
        let mut g = EchoGuard::default();
        g.said("The answer is 42.");
        assert!(g.is_echo("the answer is forty two"));
    }

    #[test]
    fn echo_window_is_fifteen_seconds() {
        let mut g = EchoGuard::default();
        g.said.push_back((
            Instant::now() - Duration::from_secs(16),
            normalize_tokens("old line"),
        ));
        assert!(!g.is_echo("old line"));
    }

    #[test]
    fn echo_suspect_only_right_after_speaking() {
        let mut g = EchoGuard::default();
        assert!(!g.recently_live(Duration::from_secs(3)));
        g.sync_output_buffer(true);
        assert!(g.recently_live(Duration::from_secs(3)));
        g.quiet_since = Some(Instant::now() - Duration::from_secs(4));
        g.output_live = false;
        assert!(!g.recently_live(Duration::from_secs(3)));
    }
}
