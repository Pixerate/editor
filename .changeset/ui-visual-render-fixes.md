---
"@pixerate/editor": patch
---

Better renders for the UI components on small and themed canvases (#819):

- `braid` takes fewer turns when its axis is short (at least 3.5 amplitudes per turn), so a narrow braid keeps open twists instead of tight coils; its strand labels are spread a line apart and kept inside the picture, with a short leader where a label moves off its strand's end.
- `donut-chart` puts its legend beside the ring when the picture is at least 1.2 times as wide as it is tall, so the ring takes the height.
- `chartPaletteWithAccent(accent)` (`/chart`): series, slices and strands after the accent skip palette colours within ΔE 0.1 (OKLab) of it, so an aesthetic's coral accent no longer sits beside the palette's coral. Used by `bar-chart`, `line-chart`, `donut-chart` and `braid`; the default accents keep the palette as before.
- Render versions: `braid` and `donut-chart` 2. Their content hashes change; the other types' do not.
