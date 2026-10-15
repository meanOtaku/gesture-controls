# Bundled fonts

`ShipporiMinchoB1-ExtraBold-subset.woff2` is **Shippori Mincho B1 Extra Bold**, used by the Halftone theme for headings,
buttons and the sidebar (a free stand-in for the heavy Mincho of the Neon Genesis Evangelion title cards).

- Source: `https://raw.githubusercontent.com/google/fonts/main/ofl/shipporiminchob1/ShipporiMinchoB1-ExtraBold.ttf`
  (SHA-256 of the original: `bee99a242f32128e8d6a4acff2b3f1742cd42ea90748758e6e10456871887e76`, 15,088,060 bytes).
- Licence: SIL Open Font License 1.1, copyright 2021 The Shippori Mincho Project Authors
  (<https://github.com/fontdasu/ShipporiMincho>). The licence text is in `ShipporiMincho-OFL.txt`. The font is a
  modified (subset) version of the original, under the same licence and without the reserved name being used as an
  endorsement.
- This file is a subset (80,544 bytes, SHA-256 `d020cba073a4b52a7b2774309ae4a0695fd5c79c0a2b144c096db6e6bc8948b3`) with
  Basic Latin, Latin-1, general punctuation, arrows, CJK punctuation, hiragana, katakana and full-width forms, made with:

  ```
  uv run --with fonttools --with brotli pyftsubset ShipporiMinchoB1-ExtraBold.ttf \
    --unicodes="U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-203A,U+20AC,U+2190-2193,U+3000-303F,U+3040-309F,U+30A0-30FF,U+FF01-FF60" \
    --layout-features='*' --flavor=woff2 --output-file=ShipporiMinchoB1-ExtraBold-subset.woff2
  ```

  Kanji are not included: a heading with kanji falls back to the system Mincho for those characters.

## Shippori Mincho B1 Medium

`ShipporiMinchoB1-Medium-subset.woff2` is the Medium weight of the same family, used for body text in the Halftone theme.

- Source: `https://raw.githubusercontent.com/google/fonts/main/ofl/shipporiminchob1/ShipporiMinchoB1-Medium.ttf`
  (SHA-256 of the original: `0712348124729e30507a9ed9d7c8939125f13605954596acfe0ec4a6341e3b9d`, 15,185,140 bytes).
- Same licence (SIL OFL 1.1, `ShipporiMincho-OFL.txt`). Subset: 80,088 bytes, SHA-256
  `7f4305ac120029e31f1aa2fcdf50ea7b5d77db73afc94040f617047788647887`, made with the same command as above plus
  `U+2212,U+2264,U+2265,U+00D7` (minus, less/greater-or-equal, multiplication signs) in the `--unicodes` list.
