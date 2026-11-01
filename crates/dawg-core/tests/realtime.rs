//! Allocation guard: the audio callback path must never touch the heap.
//!
//! This test binary installs a counting global allocator. Code run inside
//! [`assert_no_alloc`] fails the test if it allocates, reallocates or frees on
//! the calling thread.

mod common;

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use dawg_core::{Renderer, OUT_CHANNELS};

struct GuardAlloc;

thread_local! {
    static GUARDED: Cell<bool> = const { Cell::new(false) };
    static VIOLATIONS: Cell<usize> = const { Cell::new(0) };
}

fn note() {
    // try_with: the thread-locals may already be gone while a thread exits.
    let _ = GUARDED.try_with(|g| {
        if g.get() {
            let _ = VIOLATIONS.try_with(|v| v.set(v.get() + 1));
        }
    });
}

unsafe impl GlobalAlloc for GuardAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        note();
        System.alloc(layout)
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        note();
        System.alloc_zeroed(layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        note();
        System.realloc(ptr, layout, new_size)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        note();
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static ALLOC: GuardAlloc = GuardAlloc;

/// Runs `f` and returns how many heap operations it made on this thread.
fn count_allocs(f: impl FnOnce()) -> usize {
    VIOLATIONS.with(|v| v.set(0));
    GUARDED.with(|g| g.set(true));
    f();
    GUARDED.with(|g| g.set(false));
    VIOLATIONS.with(|v| v.get())
}

fn assert_no_alloc(what: &str, f: impl FnOnce()) {
    let n = count_allocs(f);
    assert_eq!(n, 0, "{what} made {n} heap operations on the audio path");
}

#[test]
fn guard_catches_allocations() {
    let n = count_allocs(|| {
        std::hint::black_box(vec![0u8; 64]);
    });
    assert!(n >= 1, "the guard missed an allocation");
}

#[test]
fn process_does_not_allocate() {
    for scene in common::scenes() {
        for frames in [1, 64, 128, 480, 1024] {
            let mut buf = vec![0.0f32; frames * OUT_CHANNELS];
            let mut renderer = Renderer::new(scene.project.clone(), 0);
            assert_no_alloc(scene.name, || {
                while renderer.position() < scene.frames as u64 {
                    renderer.process(&mut buf);
                }
                renderer.seek(0);
                renderer.process(&mut buf);
            });
        }
    }
}

#[test]
fn player_fill_does_not_allocate_or_free() {
    use dawg_core::player::{player, PlayerMsg};

    for scene in common::scenes() {
        for device_rate in [scene.project.sample_rate, 44_100] {
            let (mut player, mut handle) = player(scene.project.clone(), device_rate, 2);
            let mut buf = vec![0.0f32; 480 * 2];
            // Swapping in a new snapshot hands the old one back instead of
            // freeing it in the callback.
            let next = std::sync::Arc::new((*scene.project).clone());
            handle.send(PlayerMsg::Project(next));
            // The analyser listening to the first track.
            if let Some(t) = scene.project.tracks.first() {
                handle.spectrum(Some(t.id), scene.project.sample_rate);
            }
            // Long enough to loop back twice.
            handle.send(PlayerMsg::Play {
                from: 0,
                to: scene.frames as u64,
                looping: Some(0),
            });
            assert_no_alloc(scene.name, || {
                for _ in 0..20 {
                    player.fill(&mut buf);
                }
            });
            // A loop dragged shorter mid-playback, then past the playhead.
            handle.send(PlayerMsg::Bounds {
                to: scene.frames as u64 / 2,
                looping: Some(0),
            });
            handle.send(PlayerMsg::Bounds {
                to: scene.frames as u64,
                looping: Some(scene.frames as u64 / 2),
            });
            assert_no_alloc(scene.name, || {
                for _ in 0..5 {
                    player.fill(&mut buf);
                }
            });
            // A clip moved while playing, twice in one crossfade.
            for shift in [100, 200] {
                let mut moved = (*scene.project).clone();
                for t in &mut moved.tracks {
                    for c in &mut t.clips {
                        c.start += shift;
                    }
                }
                handle.send(PlayerMsg::Project(std::sync::Arc::new(moved)));
            }
            assert_no_alloc(scene.name, || {
                for _ in 0..5 {
                    player.fill(&mut buf);
                }
            });
            handle.collect();
            handle.send(PlayerMsg::Stop);
            assert_no_alloc(scene.name, || player.fill(&mut buf));
        }
    }
}

#[test]
fn ramps_and_eq_crossfades_do_not_allocate() {
    use dawg_core::{BandKind, Eq, EqBand};

    for scene in common::scenes() {
        // Every live value changed at once: volume, pan, mute, clip gain,
        // master and the EQ (on where it was off, bypassed where it was on).
        let mut next = (*scene.project).clone();
        next.master_gain *= 0.5;
        for (i, t) in next.tracks.iter_mut().enumerate() {
            t.gain *= 0.5;
            t.pan = if t.pan > 0.0 { -1.0 } else { 1.0 };
            t.muted = i % 2 == 1;
            for c in &mut t.clips {
                c.gain *= 0.5;
                // Moved and trimmed: crossfades from the old clips.
                c.start += 100;
                c.len = c.len.saturating_sub(50).max(1);
            }
            t.eq = if t.eq.active() {
                Eq::new(t.eq.bands(), true, next.sample_rate)
            } else {
                let band = EqBand {
                    kind: BandKind::Bell,
                    freq: 1000.0,
                    gain_db: 6.0,
                    q: 1.0,
                    slope: 12,
                    on: true,
                };
                Eq::new(&[band], false, next.sample_rate)
            };
        }
        // A track deleted (fading out) and one added (fading in).
        if let Some(t) = next.tracks.pop() {
            let mut added = t.clone();
            added.id = next.next_id;
            next.tracks.insert(0, added);
        }
        let next = std::sync::Arc::new(next);
        let mut renderer = Renderer::new(scene.project.clone(), 0);
        let mut buf = vec![0.0f32; 128 * OUT_CHANNELS];
        renderer.process(&mut buf);
        let _ = renderer.swap_project(next.clone());
        assert_no_alloc(scene.name, || {
            for _ in 0..20 {
                renderer.process(&mut buf);
            }
        });
        // And straight back, mid-ramp.
        let _ = renderer.swap_project(scene.project.clone());
        assert_no_alloc(scene.name, || {
            for _ in 0..20 {
                renderer.process(&mut buf);
            }
        });
    }
}
