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
            handle.send(PlayerMsg::Stop);
            assert_no_alloc(scene.name, || player.fill(&mut buf));
        }
    }
}
