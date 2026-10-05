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

- **Source:** derived from [File:Woman smiling.jpg](https://commons.wikimedia.org/wiki/File:Woman_smiling.jpg): center crop resized so the face spans ~70% of image width, 1350×1350.
- **Author:** Ernie Branson (Photographer; original)
- **License:** Public domain
- **Notes:** YouCam-compliant live-prove fixture (passes live skin-analysis v2.1 `>60%` face-width rule and skin-tone v2.0 on the same frame). Use for live demos; see `apps/server/fixtures/ATTRIBUTION.md` for details.
