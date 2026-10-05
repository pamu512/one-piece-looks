# Demo fixture images (inputs only)

Bundled sample **input** photos for demo / prove / canned-capture fallback.
Never use these as canned **outputs**. See API-CONTRACT.md "Canned-input path".

## lipstick-tube.jpg

- **Source:** Wikimedia Commons — [File:Lipstick (product).jpg](https://commons.wikimedia.org/wiki/File:Lipstick_(product).jpg)
- **Author:** Maria Morri (via Flickr)
- **License:** [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/)
- **Notes:** Lipstick product / tube close-up for product-capture sampling.

## face-portrait.jpg

- **Source:** Wikimedia Commons — [File:Woman smiling.jpg](https://commons.wikimedia.org/wiki/File:Woman_smiling.jpg)
- **Author:** Ernie Branson (Photographer)
- **License:** Public domain
- **Notes:** Clear face photo for face-capture / skin analysis input. Short side ≥ 1080 (suitable for HD path when live).

Copies also live under `apps/server/fixtures/` for the HTTP prove script.

## face-portrait-live.jpg

- **Source:** derived from [File:Old woman of Don Puay white shirt grey hair wrinkled skin.jpg](https://commons.wikimedia.org/wiki/File:Old_woman_of_Don_Puay_white_shirt_grey_hair_wrinkled_skin.jpg): rotated ~4° clockwise and center-cropped (face ~80% of frame width), resized to 1080×1620.
- **Author:** Basile Morin
- **License:** [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
- **Notes:** YouCam-compliant live-prove fixture. Live-verified 2026-10-02 against all three YouCam s2s APIs on this exact frame: skin-analysis v2.1 hd_skin_type (PASS, `Dry`), skin-tone-analysis v2.0 (PASS, `#ad8567`), makeup-vto v2.0 incl. `eyebrows` effect (PASS). The full-frame `face-portrait.jpg` fails live (`error_src_face_too_small`); use this file for `prove:lipstick` and demo canned-input. sha256 `72ae197ecf9e2781d8eb510216a93205a7fd080b4deeb01134fa67eaa517a1ba`.

## face-portrait-test.jpg

- Downscaled JPEG derived from `face-portrait.jpg` (same license) for fast unit tests only.
