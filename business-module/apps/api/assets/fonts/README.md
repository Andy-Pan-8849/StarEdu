# Transcript font

`NotoSansSC-Regular-subset.ttf` is **Noto Sans SC** (Regular, weight 400) cut down to the characters a transcript needs:
ASCII, Latin-1, general and CJK punctuation, full-width forms, and the 3,755 level-1 hanzi of GB 2312 plus its symbols (about 99.7% of everyday Chinese text).
It is used for every transcript PDF. A character that is not in the subset prints as `?`.

Licence: SIL Open Font License 1.1 (`OFL.txt`, from github.com/google/fonts, `ofl/notosanssc`). The font keeps its name, "Noto Sans SC";
it is not named after the reserved font name in the copyright line.

How it was made (fonttools): instantiate the variable font at wght=400, then `fontTools.subset` with the character set above (no hinting, only the `kern` feature).
To use another font for all transcripts, set `TRANSCRIPT_FONT_PATH` to a TTF/OTF file.
