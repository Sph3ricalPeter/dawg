//! Waveform peaks: min/max per block at several zoom levels, so drawing any
//! view costs about one read per pixel however long the file is.

use crate::model::Source;

/// Frames per block at the finest level.
const BASE: usize = 64;
/// Each level merges this many blocks of the one below.
const FACTOR: usize = 4;

#[derive(Debug, Clone)]
pub struct Peaks {
    /// `levels[k]` holds `(min, max)` per `BASE * FACTOR^k` frames, over all
    /// channels.
    levels: Vec<Vec<(f32, f32)>>,
}

impl Peaks {
    pub fn new(source: &Source) -> Self {
        let ch = source.channels() as usize;
        let s = source.samples();
        let frames = source.frames() as usize;
        let mut level: Vec<(f32, f32)> = (0..frames.div_ceil(BASE))
            .map(|b| {
                let from = b * BASE * ch;
                let to = ((b + 1) * BASE).min(frames) * ch;
                minmax(&s[from..to])
            })
            .collect();
        let mut levels = Vec::new();
        while level.len() > 1 {
            let next = level.chunks(FACTOR).map(merge).collect();
            levels.push(std::mem::replace(&mut level, next));
        }
        levels.push(level);
        Self { levels }
    }

    /// `buckets` `(min, max)` pairs covering source frames `from..to`. Buckets
    /// past the end of the source are `(0, 0)`.
    pub fn query(&self, source: &Source, from: f64, to: f64, buckets: usize) -> Vec<(f32, f32)> {
        if source.frames() == 0 {
            return vec![(0.0, 0.0); buckets];
        }
        let ch = source.channels() as usize;
        let s = source.samples();
        let frames = source.frames() as f64;
        let per = (to - from) / buckets.max(1) as f64;
        // The coarsest level whose blocks still fit in a bucket.
        let mut lvl = None;
        let mut size = BASE as f64;
        for k in 0..self.levels.len() {
            if size > per {
                break;
            }
            lvl = Some(k);
            size *= FACTOR as f64;
        }

        (0..buckets)
            .map(|b| {
                let a = (from + b as f64 * per).max(0.0);
                let z = (from + (b + 1) as f64 * per).min(frames);
                if z <= a {
                    return (0.0, 0.0);
                }
                match lvl {
                    None => {
                        let (a, z) = (a as usize, (z.ceil() as usize).max(a as usize + 1));
                        minmax(&s[a * ch..z.min(frames as usize) * ch])
                    }
                    Some(k) => {
                        let block = BASE * FACTOR.pow(k as u32);
                        let (a, z) = (a as usize / block, (z.ceil() as usize).div_ceil(block));
                        let l = &self.levels[k];
                        merge(&l[a.min(l.len() - 1)..z.min(l.len()).max(a + 1)])
                    }
                }
            })
            .collect()
    }
}

fn minmax(s: &[f32]) -> (f32, f32) {
    s.iter()
        .fold((f32::MAX, f32::MIN), |(lo, hi), &x| (lo.min(x), hi.max(x)))
        .pipe_empty()
}

fn merge(p: &[(f32, f32)]) -> (f32, f32) {
    p.iter()
        .fold((f32::MAX, f32::MIN), |(lo, hi), &(a, b)| {
            (lo.min(a), hi.max(b))
        })
        .pipe_empty()
}

trait EmptyAsZero {
    fn pipe_empty(self) -> (f32, f32);
}

impl EmptyAsZero for (f32, f32) {
    fn pipe_empty(self) -> (f32, f32) {
        if self.0 > self.1 {
            (0.0, 0.0)
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp(n: usize) -> Source {
        Source::new(1, (0..n).map(|i| i as f32 / n as f32).collect::<Vec<_>>())
    }

    #[test]
    fn levels_agree_with_raw_samples() {
        let src = ramp(100_000);
        let p = Peaks::new(&src);
        for buckets in [10, 333, 5000, 200_000] {
            let q = p.query(&src, 0.0, 100_000.0, buckets);
            assert_eq!(q.len(), buckets);
            // Monotonic ramp: the min of the first bucket is 0 and the max of
            // the last is the last sample.
            assert_eq!(q[0].0, 0.0);
            assert_eq!(q[buckets - 1].1, 99_999.0 / 100_000.0);
            for w in q.windows(2) {
                assert!(w[0].0 <= w[1].0);
            }
        }
    }

    #[test]
    fn past_the_end_is_silent() {
        let src = ramp(1000);
        let q = Peaks::new(&src).query(&src, 500.0, 1500.0, 10);
        assert_eq!(q[9], (0.0, 0.0));
        assert!(q[0].1 > 0.0);
    }
}
