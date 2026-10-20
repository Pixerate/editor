# Colour management

The document has a colour profile, its working space: the colours its RGB numbers mean. Missing
means sRGB. The viewport assumes an sRGB display and converts other working spaces for display.

## Working method

1. **Read first**: `get_color_profile` gives the document's profile, any Proof Setup, and the
   built-in profiles (`srgb`, `display-p3`, `adobe-rgb-compat`, `prophoto-compat`,
   `linear-srgb`, `rec2020`, grey, `lab-d50`, `coated-cmyk`).
2. **Assign or convert?** `assign_profile` when the numbers are right but the profile is wrong
   or missing (a file saved without its profile): the look changes, the numbers do not.
   `convert_to_profile` to move the image into another space keeping its look (for a wide-gamut
   edit, convert to `display-p3` or `prophoto-compat`; for the web, convert to `srgb`). Each is one
   undo step.
3. **Pick the intent**: `relative` (default) for photos, keeping in-gamut colours exact and
   clipping the rest; `perceptual` when much of the image is out of gamut and smoothness matters
   more than exactness; `saturation` for charts and logos; `absolute` only for proofing a paper
   colour. Keep black point compensation on unless asked.
4. **Soft proof before printing**: `set_proof_setup` with `coated-cmyk` (or the printer's
   profile as `icc:<base64>`), `gamutWarning: true` to grey out colours the press cannot hit;
   look with `capture_view`; adjust (lower saturation in the greyed areas); then `off: true`.
5. **Numbers for a print brief**: `convert_colors` gives CMYK percentages (values × 100) and
   Lab for any `#rrggbb`, without changing the document.

## Pitfalls

- The working space must be RGB: CMYK, grey and Lab profiles are for proofing and
  `convert_colors` here.
- `convert_to_profile` converts pixel layers (and the source image). Shape and type colours,
  layer effects and smart objects keep their numbers and are listed in `unconvertedLayerIds`:
  check them and recolour if the look matters.
- Images opened from a URL or file in the browser arrive already converted to sRGB by the
  browser, so their own profile is not kept; PSDs keep theirs (resource 1039).
- `export_psd` always embeds the profile; PNG and JPEG exports embed it when it is not sRGB.
- The first proof or conversion with `coated-cmyk` builds that profile, which takes a second or
  two.
