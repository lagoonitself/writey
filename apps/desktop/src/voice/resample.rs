//! Sample-rate conversion for speech: the mic runs at 44.1/48 kHz, the models want 16 kHz,
//! and Kokoro speaks at 24 kHz into a 44.1/48 kHz speaker. Linear interpolation behind a
//! short averaging filter is plenty for voice.

pub struct Resampler {
    ratio: f64,
    /// Position of the next output sample, in input samples since `last`.
    pos: f64,
    last: f32,
    /// Box filter width when downsampling (anti-aliasing), 1 otherwise.
    taps: usize,
    history: Vec<f32>,
}

impl Resampler {
    pub fn new(from_hz: u32, to_hz: u32) -> Self {
        let ratio = from_hz as f64 / to_hz as f64;
        let taps = if ratio > 1.0 {
            ratio.round().max(1.0) as usize
        } else {
            1
        };
        Self {
            ratio,
            pos: 0.0,
            last: 0.0,
            taps,
            history: Vec::new(),
        }
    }

    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if (self.ratio - 1.0).abs() < 1e-9 {
            return input.to_vec();
        }
        let filtered: Vec<f32> = if self.taps > 1 {
            let mut buf = std::mem::take(&mut self.history);
            buf.extend_from_slice(input);
            let n = self.taps;
            let out = (0..input.len())
                .map(|i| {
                    let end = buf.len() - input.len() + i + 1;
                    let start = end.saturating_sub(n);
                    buf[start..end].iter().sum::<f32>() / (end - start) as f32
                })
                .collect();
            let keep = buf.len().min(n);
            self.history = buf[buf.len() - keep..].to_vec();
            out
        } else {
            input.to_vec()
        };
        let mut out = Vec::with_capacity((filtered.len() as f64 / self.ratio) as usize + 2);
        // Sample i of `filtered` sits at position i + 1 after `last` (position 0).
        while self.pos < filtered.len() as f64 {
            let i = self.pos.floor() as usize;
            let frac = (self.pos - i as f64) as f32;
            let a = if i == 0 { self.last } else { filtered[i - 1] };
            let b = filtered[i];
            out.push(a + (b - a) * frac);
            self.pos += self.ratio;
        }
        self.pos -= filtered.len() as f64;
        if let Some(&l) = filtered.last() {
            self.last = l;
        }
        out
    }
}

/// Averages interleaved channels into one.
pub fn to_mono(data: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }
    data.chunks(channels)
        .map(|f| f.iter().sum::<f32>() / f.len() as f32)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_match_the_ratio_across_chunks() {
        let mut r = Resampler::new(48_000, 16_000);
        let mut n = 0;
        for _ in 0..100 {
            n += r.process(&[0.5; 480]).len();
        }
        assert!((15_990..=16_010).contains(&n), "{n}");
        let mut up = Resampler::new(24_000, 48_000);
        let out = up.process(&[1.0; 2400]);
        assert!((4790..=4810).contains(&out.len()));
        assert!(out[10..].iter().all(|v| (v - 1.0).abs() < 1e-6));
    }

    #[test]
    fn keeps_a_sine_shape() {
        let mut r = Resampler::new(48_000, 16_000);
        let input: Vec<f32> = (0..48_000)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin())
            .collect();
        let out = r.process(&input);
        let peak = out.iter().cloned().fold(0.0f32, f32::max);
        assert!(peak > 0.9 && peak <= 1.0, "{peak}");
    }

    #[test]
    fn mono() {
        assert_eq!(to_mono(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
    }
}
