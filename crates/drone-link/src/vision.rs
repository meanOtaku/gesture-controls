//! Turns the drone's video into a measure of how the picture is moving, as a mouse's optical sensor does.
//!
//! Video frames are JPEGs without their headers, and small patches of each frame are searched for in the next one.
//! The camera faces forward, so sideways drift or a turn slides the picture sideways, climbing or tilting slides it up
//! and down, and flying forward spreads it outward from the centre. There is no attitude data to tell a tilt from a
//! drift, so this measures the picture only. Damaged frames and blank views give low confidence, not a false reading.

/// The standard quality 50 JPEG header, which the drone's video leaves off.
const JPEG_HEADER: &[u8] = include_bytes!("jpeg_header.bin");
const JPEG_END: [u8; 2] = [0xFF, 0xD9];

const SOURCE_WIDTH: usize = 640;
const SOURCE_HEIGHT: usize = 360;
const SHRINK: usize = 4;
pub const FLOW_WIDTH: usize = SOURCE_WIDTH / SHRINK;
pub const FLOW_HEIGHT: usize = SOURCE_HEIGHT / SHRINK;

const PATCH: usize = 20;
const SEARCH: i32 = 10;
const COLUMNS: usize = 5;
const ROWS: usize = 3;
/// Mean difference from the patch's own average below which a patch is too blank to follow.
const MIN_TEXTURE: f32 = 1.0;
/// A match must beat the patch's average match by this much, or the patch could fit anywhere.
const MIN_DISTINCTNESS: f32 = 1.4;
/// Patches further than this from the median, in pixels, are not moving with the picture.
const INLIER_DISTANCE: f32 = 2.0;
const MIN_PATCHES: usize = 4;
/// A measurement with less agreement than this is not added to the drift.
pub const MIN_CONFIDENCE: f32 = 0.25;

/// Adds the missing header and end marker.
pub fn to_jpeg(body: &[u8]) -> Vec<u8> {
    let mut jpeg = Vec::with_capacity(JPEG_HEADER.len() + body.len() + JPEG_END.len());
    jpeg.extend_from_slice(JPEG_HEADER);
    jpeg.extend_from_slice(body);
    jpeg.extend_from_slice(&JPEG_END);
    jpeg
}

/// How the picture moved between two frames, in pixels of the shrunken image.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Flow {
    pub dx: f32,
    pub dy: f32,
    /// Spread from the centre, per pixel of radius: above 0 means the picture grew.
    pub zoom: f32,
    /// The share of all patches agreeing, 0 to 1.
    pub confidence: f32,
}

impl Flow {
    const NONE: Self = Self {
        dx: 0.0,
        dy: 0.0,
        zoom: 0.0,
        confidence: 0.0,
    };
}

/// A shrunken greyscale frame.
#[derive(Debug, Clone, PartialEq)]
pub struct Luma(Vec<u8>);

impl Luma {
    /// Decodes a full JPEG. `None` for one that is damaged or the wrong shape.
    pub fn decode(jpeg: &[u8]) -> Option<Self> {
        let mut decoder = jpeg_decoder::Decoder::new(jpeg);
        let pixels = decoder.decode().ok()?;
        let info = decoder.info()?;
        if usize::from(info.width) != SOURCE_WIDTH
            || usize::from(info.height) != SOURCE_HEIGHT
            || info.pixel_format != jpeg_decoder::PixelFormat::RGB24
        {
            return None;
        }
        Some(Self::shrink(&pixels))
    }

    fn shrink(rgb: &[u8]) -> Self {
        let mut luma = vec![0; FLOW_WIDTH * FLOW_HEIGHT];
        for (row, out) in luma.chunks_exact_mut(FLOW_WIDTH).enumerate() {
            for (column, value) in out.iter_mut().enumerate() {
                let mut total = 0u32;
                for y in 0..SHRINK {
                    let start = ((row * SHRINK + y) * SOURCE_WIDTH + column * SHRINK) * 3;
                    for pixel in rgb[start..start + SHRINK * 3].chunks_exact(3) {
                        total += u32::from(pixel[1]);
                    }
                }
                *value = (total / (SHRINK * SHRINK) as u32) as u8;
            }
        }
        Self(luma)
    }

    fn at(&self, x: usize, y: usize) -> f32 {
        f32::from(self.0[y * FLOW_WIDTH + x])
    }
}

/// Mean of a patch, so comparisons follow shapes and not brightness, which the camera keeps changing.
fn mean(image: &Luma, x: usize, y: usize) -> f32 {
    let mut total = 0.0;
    for row in y..y + PATCH {
        for column in x..x + PATCH {
            total += image.at(column, row);
        }
    }
    total / (PATCH * PATCH) as f32
}

fn texture(image: &Luma, x: usize, y: usize, average: f32) -> f32 {
    let mut total = 0.0;
    for row in y..y + PATCH {
        for column in x..x + PATCH {
            total += (image.at(column, row) - average).abs();
        }
    }
    total / (PATCH * PATCH) as f32
}

fn difference(before: &Luma, after: &Luma, x: usize, y: usize, dx: i32, dy: i32, gap: f32) -> f32 {
    let mut total = 0.0;
    for row in 0..PATCH {
        for column in 0..PATCH {
            let moved_x = (x + column) as i32 + dx;
            let moved_y = (y + row) as i32 + dy;
            total += (before.at(x + column, y + row)
                - after.at(moved_x as usize, moved_y as usize)
                + gap)
                .abs();
        }
    }
    total
}

/// Refines a best match between whole pixels from the costs on either side of it.
fn refine(left: f32, best: f32, right: f32) -> f32 {
    let curve = left + right - 2.0 * best;
    if curve <= f32::EPSILON {
        0.0
    } else {
        (0.5 * (left - right) / curve).clamp(-0.5, 0.5)
    }
}

struct PatchMove {
    x: f32,
    y: f32,
    dx: f32,
    dy: f32,
}

/// Where a patch went, or `None` if it is blank, ambiguous or left the search area.
fn follow(before: &Luma, after: &Luma, x: usize, y: usize) -> Option<PatchMove> {
    let average = mean(before, x, y);
    if texture(before, x, y, average) < MIN_TEXTURE {
        return None;
    }
    let side = (2 * SEARCH + 1) as usize;
    let mut costs = vec![0.0; side * side];
    let mut best = (f32::MAX, 0usize, 0usize);
    let mut sum = 0.0;
    for (row, line) in costs.chunks_exact_mut(side).enumerate() {
        for (column, cost) in line.iter_mut().enumerate() {
            let dx = column as i32 - SEARCH;
            let dy = row as i32 - SEARCH;
            let gap = mean_shifted(after, x, y, dx, dy) - average;
            *cost = difference(before, after, x, y, dx, dy, gap);
            sum += *cost;
            if *cost < best.0 {
                best = (*cost, column, row);
            }
        }
    }
    let (cost, column, row) = best;
    let on_edge = column == 0 || row == 0 || column == side - 1 || row == side - 1;
    if on_edge || sum / (side * side) as f32 / cost.max(1.0) < MIN_DISTINCTNESS {
        return None;
    }
    let at = |c: usize, r: usize| costs[r * side + c];
    let dx = column as f32 - SEARCH as f32 + refine(at(column - 1, row), cost, at(column + 1, row));
    let dy = row as f32 - SEARCH as f32 + refine(at(column, row - 1), cost, at(column, row + 1));
    let half = PATCH as f32 / 2.0;
    Some(PatchMove {
        x: x as f32 + half - FLOW_WIDTH as f32 / 2.0,
        y: y as f32 + half - FLOW_HEIGHT as f32 / 2.0,
        dx,
        dy,
    })
}

fn mean_shifted(image: &Luma, x: usize, y: usize, dx: i32, dy: i32) -> f32 {
    mean(image, (x as i32 + dx) as usize, (y as i32 + dy) as usize)
}

fn median(values: &mut [f32]) -> f32 {
    values.sort_by(f32::total_cmp);
    values[values.len() / 2]
}

/// How the picture moved from `before` to `after`.
pub fn measure(before: &Luma, after: &Luma) -> Flow {
    let margin = SEARCH as usize;
    let usable_width = FLOW_WIDTH - 2 * margin - PATCH;
    let usable_height = FLOW_HEIGHT - 2 * margin - PATCH;
    let mut moves = Vec::with_capacity(COLUMNS * ROWS);
    for row in 0..ROWS {
        for column in 0..COLUMNS {
            let x = margin + usable_width * column / (COLUMNS - 1);
            let y = margin + usable_height * row / (ROWS - 1);
            moves.extend(follow(before, after, x, y));
        }
    }
    if moves.len() < MIN_PATCHES {
        return Flow::NONE;
    }
    let dx = median(&mut moves.iter().map(|m| m.dx).collect::<Vec<_>>());
    let dy = median(&mut moves.iter().map(|m| m.dy).collect::<Vec<_>>());
    moves.retain(|m| (m.dx - dx).hypot(m.dy - dy) <= INLIER_DISTANCE);
    if moves.len() < MIN_PATCHES {
        return Flow::NONE;
    }
    let spread: f32 = moves
        .iter()
        .map(|m| (m.dx - dx) * m.x + (m.dy - dy) * m.y)
        .sum();
    let radius: f32 = moves.iter().map(|m| m.x * m.x + m.y * m.y).sum();
    Flow {
        dx,
        dy,
        zoom: spread / radius.max(1.0),
        confidence: moves.len() as f32 / (COLUMNS * ROWS) as f32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A smooth random-looking scene, sampled at any position so it can be shifted or zoomed.
    fn scene(x: f32, y: f32) -> f32 {
        let wave = (x * 0.31).sin() * (y * 0.23).cos()
            + (x * 0.13 + y * 0.17).sin()
            + (x * 0.07 - y * 0.11).cos()
            + (x * 0.47 + 1.0).sin() * (y * 0.41 + 2.0).sin();
        (wave * 28.0 + 100.0).clamp(0.0, 255.0)
    }

    fn image(place: impl Fn(f32, f32) -> (f32, f32)) -> Luma {
        let mut pixels = Vec::with_capacity(FLOW_WIDTH * FLOW_HEIGHT);
        for y in 0..FLOW_HEIGHT {
            for x in 0..FLOW_WIDTH {
                let (x, y) = place(x as f32, y as f32);
                pixels.push(scene(x, y) as u8);
            }
        }
        Luma(pixels)
    }

    fn shifted(dx: f32, dy: f32) -> Luma {
        image(move |x, y| (x - dx, y - dy))
    }

    #[test]
    fn a_still_picture_reads_as_still() {
        let flow = measure(&shifted(0.0, 0.0), &shifted(0.0, 0.0));
        assert!(flow.dx.abs() < 0.01 && flow.dy.abs() < 0.01, "{flow:?}");
        assert!(flow.confidence > 0.6, "{flow:?}");
    }

    #[test]
    fn whole_pixel_moves_are_measured() {
        let flow = measure(&shifted(0.0, 0.0), &shifted(5.0, -3.0));
        assert!((flow.dx - 5.0).abs() < 0.3, "{flow:?}");
        assert!((flow.dy + 3.0).abs() < 0.3, "{flow:?}");
    }

    #[test]
    fn fractions_of_a_pixel_are_measured() {
        let flow = measure(&shifted(0.0, 0.0), &shifted(1.5, 0.5));
        assert!((flow.dx - 1.5).abs() < 0.4, "{flow:?}");
        assert!((flow.dy - 0.5).abs() < 0.4, "{flow:?}");
    }

    #[test]
    fn a_brightness_change_is_not_movement() {
        let before = shifted(0.0, 0.0);
        let brighter = Luma(before.0.iter().map(|v| v.saturating_add(30)).collect());
        let flow = measure(&before, &brighter);
        assert!(flow.dx.abs() < 0.2 && flow.dy.abs() < 0.2, "{flow:?}");
        assert!(flow.confidence > 0.6, "{flow:?}");
    }

    #[test]
    fn a_blank_view_gives_no_confidence() {
        let blank = Luma(vec![90; FLOW_WIDTH * FLOW_HEIGHT]);
        assert_eq!(measure(&blank, &blank), Flow::NONE);
    }

    #[test]
    fn moving_closer_reads_as_zoom_with_no_drift() {
        let closer = image(|x, y| {
            let (cx, cy) = (FLOW_WIDTH as f32 / 2.0, FLOW_HEIGHT as f32 / 2.0);
            (cx + (x - cx) / 1.04, cy + (y - cy) / 1.04)
        });
        let flow = measure(&shifted(0.0, 0.0), &closer);
        assert!(flow.zoom > 0.02, "{flow:?}");
        assert!(flow.dx.abs() < 0.6 && flow.dy.abs() < 0.6, "{flow:?}");
    }

    #[test]
    fn unrelated_pictures_do_not_invent_a_confident_move() {
        let other = image(|x, y| (y * 3.1 + 500.0, x * 2.7 - 300.0));
        let flow = measure(&shifted(0.0, 0.0), &other);
        assert!(flow.confidence < 0.4, "{flow:?}");
    }

    #[test]
    fn the_header_and_end_marker_go_around_the_body() {
        let jpeg = to_jpeg(&[1, 2, 3]);
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
        assert_eq!(jpeg.len(), 605 + 3 + 2);
        assert_eq!(&jpeg[605..], &[1, 2, 3, 0xFF, 0xD9]);
    }

    #[test]
    fn a_damaged_jpeg_is_refused() {
        assert!(Luma::decode(&[0xFF, 0xD8, 0x00]).is_none());
    }
}
