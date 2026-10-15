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

## NERV theme fonts (Oswald, JetBrains Mono, Noto Serif Display)

Used by the NERV theme. All three are SIL Open Font License 1.1 (licence texts: `Oswald-OFL.txt`,
`JetBrainsMono-OFL.txt`, `NotoSerifDisplay-OFL.txt`), taken from the Google Fonts repository
(`https://github.com/google/fonts/tree/main/ofl`) and subset to Basic Latin, Latin-1, general punctuation, arrows, the
minus, comparison and degree signs. Subsets are modified versions under the same licence.

| File | Original (SHA-256, bytes) | Subset (SHA-256, bytes) |
| --- | --- | --- |
| `Oswald-subset.woff2` (variable weight 200–700) | `5b38c246e255a12f5712d640d56bcced0472466fc68983d2d0410ec0457c2817`, 172,088 | `155697efb8fa09ae8710bdb9b7e5ad0f99fbdf046f45b8878e14d2a02aeab1f8`, 25,556 |
| `JetBrainsMono-subset.woff2` (variable weight 100–800) | `48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda`, 187,208 | `cbc938dfda0187df556ac0eaba6293be630f13ed40ef4f937908427769c4b4f4`, 39,344 |
| `NotoSerifDisplay-subset.woff2` (weight 700–900, width 100) | `4b661adcf6a5d38bf5befdc4d976e8a7238a4aeb57e62c1c1a67775380a09df9`, 1,835,176 | `b606ecee1cec8b673a704a7e515c1295bb5f1befe0a65b8e88ddb8e578a3fa42`, 19,508 |

Noto Serif Display was first pinned with `fontTools.varLib.instancer` (`wdth=100`, `wght=700:900`) to drop the width axis,
then subset with `pyftsubset --unicodes="U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-203A,U+2190-2193,U+2212,U+2264,U+2265,U+00B0" --flavor=woff2`
(Oswald and JetBrains Mono: the same command without the pinning step).

## League Gothic

`LeagueGothic-subset.woff2` is **League Gothic** (variable in width, 75–100), used by the NERV theme for headings, card
titles, the menu and the top bar: tall, thin capitals.

- Source: `https://raw.githubusercontent.com/google/fonts/main/ofl/leaguegothic/LeagueGothic[wdth].ttf`
  (SHA-256 of the original: `3b0e998c9a0034222394ffecdd383e6948259ad037b95555b139a217629ce1d0`, 65,972 bytes).
- Licence: SIL Open Font License 1.1, copyright 2010 The League Gothic Project Authors
  (<https://github.com/theleagueof/league-gothic>). The licence text is in `LeagueGothic-OFL.txt`. The font is a modified
  (subset) version of the original, under the same licence.
- Subset: 16,176 bytes, SHA-256 `93a2660ff696335c2c38faa37e690537ba68664c9cb7384e3dc4e785dea40456`, made with the same
  `pyftsubset` command and character list as the other NERV fonts above (`--layout-features='*' --flavor=woff2`).
