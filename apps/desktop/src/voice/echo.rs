//! Writey hearing itself. Through speakers the mic picks up Writey's own voice; there is no
//! browser echo canceller in a desktop app, so a line heard while (or just after) Writey
//! spoke is dropped when it's mostly words Writey just said. "Stop" or "wait" over its voice
//! still gets through. With headphones none of this matters.

use std::collections::{HashSet, VecDeque};
use std::time::{Duration, Instant};

/// How long after speaking a line can still be an echo (room and buffer latency).
const TAIL: Duration = Duration::from_millis(1500);
const REMEMBER: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct EchoGuard {
    said: VecDeque<(Instant, String)>,
    /// When playback last stopped (None while playing).
    quiet_since: Option<Instant>,
    playing: bool,
}

fn words(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
        .collect()
}

impl EchoGuard {
    pub fn said(&mut self, text: &str) {
        let now = Instant::now();
        self.said.retain(|(t, _)| now.duration_since(*t) < REMEMBER);
        self.said.push_back((now, text.to_string()));
    }

    pub fn set_playing(&mut self, on: bool) {
        if self.playing && !on {
            self.quiet_since = Some(Instant::now());
        }
        self.playing = on;
    }

    /// Writey's voice may be in the mic right now.
    pub fn live(&self) -> bool {
        self.playing || self.quiet_since.is_some_and(|t| t.elapsed() < TAIL)
    }

    /// A line heard while Writey's voice was live is an echo if most of its words are ones
    /// Writey just said.
    pub fn is_echo(&self, heard: &str, during_speech: bool) -> bool {
        if !during_speech {
            return false;
        }
        let heard = words(heard);
        if heard.is_empty() {
            return true;
        }
        let said: HashSet<String> = self.said.iter().flat_map(|(_, s)| words(s)).collect();
        let hits = heard.iter().filter(|w| said.contains(*w)).count();
        hits * 10 >= heard.len() * 6
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_its_own_voice_but_not_interruptions() {
        let mut g = EchoGuard::default();
        g.said("Integrate by parts, with u equal to x.");
        g.set_playing(true);
        assert!(g.live());
        assert!(g.is_echo("integrate by parts with u equal", true));
        assert!(!g.is_echo("stop", true));
        assert!(!g.is_echo("wait what's u", true));
        assert!(!g.is_echo("integrate by parts", false));
        g.set_playing(false);
        assert!(g.live());
    }
}
