//! Golden-render tests: each scene in `common::scenes` renders and is compared
//! sample by sample with `tests/golden/<name>.wav`.
//!
//! After an intended change to the sound, regenerate the files with
//! `DAWG_BLESS=1 cargo test -p dawg-core --test golden` and listen to the diff
//! before committing them.

mod common;

use std::path::{Path, PathBuf};

use dawg_core::{render, OUT_CHANNELS};

/// Largest per-sample difference accepted, about -120 dBFS.
const TOLERANCE: f32 = 1e-6;

fn golden_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(format!("{name}.wav"))
}

fn write_wav(path: &Path, rate: u32, samples: &[f32]) {
    let spec = hound::WavSpec {
        channels: OUT_CHANNELS as u16,
        sample_rate: rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut w = hound::WavWriter::create(path, spec).expect("create golden wav");
    for &s in samples {
        w.write_sample(s).expect("write golden sample");
    }
    w.finalize().expect("finalize golden wav");
}

fn read_wav(path: &Path) -> (hound::WavSpec, Vec<f32>) {
    let mut r = hound::WavReader::open(path).unwrap_or_else(|e| {
        panic!(
            "missing golden {} ({e}); run with DAWG_BLESS=1 to create it",
            path.display()
        )
    });
    let spec = r.spec();
    let samples = r.samples::<f32>().map(|s| s.unwrap()).collect();
    (spec, samples)
}

#[test]
fn golden_renders() {
    let bless = std::env::var_os("DAWG_BLESS").is_some();
    let mut failures = Vec::new();

    for scene in common::scenes() {
        let rate = scene.project.sample_rate;
        let out = render(scene.project, 0, scene.frames);
        let path = golden_path(scene.name);

        if bless {
            write_wav(&path, rate, &out);
            continue;
        }

        let (spec, want) = read_wav(&path);
        if spec.sample_rate != rate || spec.channels as usize != OUT_CHANNELS {
            failures.push(format!("{}: golden format {spec:?} is stale", scene.name));
            continue;
        }
        if want.len() != out.len() {
            failures.push(format!(
                "{}: rendered {} samples, golden has {}",
                scene.name,
                out.len(),
                want.len()
            ));
            continue;
        }
        let worst = out
            .iter()
            .zip(&want)
            .map(|(a, b)| (a - b).abs())
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((i, diff)) = worst {
            if diff > TOLERANCE {
                failures.push(format!(
                    "{}: frame {} channel {} differs by {diff:e} (got {}, want {})",
                    scene.name,
                    i / OUT_CHANNELS,
                    i % OUT_CHANNELS,
                    out[i],
                    want[i]
                ));
            }
        }
    }

    assert!(
        failures.is_empty(),
        "golden mismatches:\n{}",
        failures.join("\n")
    );
}

/// Playback in small buffers must match one offline render exactly, so what
/// you hear is what you export.
#[test]
fn chunked_playback_matches_offline_render() {
    for scene in common::scenes() {
        let whole = render(scene.project.clone(), 0, scene.frames);
        let mut renderer = dawg_core::Renderer::new(scene.project, 0);
        let mut chunked = Vec::with_capacity(whole.len());
        let mut buf = vec![0.0; 333 * OUT_CHANNELS];
        while chunked.len() < whole.len() {
            renderer.process(&mut buf);
            chunked.extend_from_slice(&buf);
        }
        chunked.truncate(whole.len());
        assert_eq!(chunked, whole, "{}", scene.name);
    }
}

/// The WAV a session saves holds what playback renders for that clip.
#[test]
fn saved_file_matches_playback() {
    use dawg_core::wav::{encode_simple, WavFile, WavFormat};
    use std::sync::Arc;

    let format = WavFormat {
        channels: 2,
        sample_rate: common::RATE,
        bits: 32,
        container_bytes: 4,
        float: true,
    };
    let signal: Vec<f64> = common::triangle(8000, 101, 0.8)
        .into_iter()
        .map(f64::from)
        .collect();
    let file = WavFile::parse(encode_simple(format, &signal)).unwrap();
    let source = Arc::new(file.decode());
    let clip = dawg_core::Clip {
        offset: 500,
        len: 3000,
        gain: 1.4,
        fade_in: 300,
        fade_out: 900,
        ..dawg_core::Clip::new(source, 500)
    };
    let project = Arc::new(dawg_core::Project::with_tracks(
        common::RATE,
        vec![dawg_core::Track {
            clips: vec![clip.clone()],
            ..Default::default()
        }],
    ));
    let played = render(project, clip.start, clip.len as usize);
    let saved = WavFile::parse(file.render_clip(&clip).unwrap())
        .unwrap()
        .decode();
    assert_eq!(saved.samples().len(), played.len());
    for (i, (a, b)) in saved.samples().iter().zip(&played).enumerate() {
        assert!(
            (a - b).abs() <= TOLERANCE,
            "sample {i}: saved {a}, played {b}"
        );
    }
}
