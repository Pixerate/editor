---
"@pixerate/editor": minor
---

`move` takes `via` waypoints, so a node follows a smooth path that passes exactly through each point.

- **Smoothness:** each axis is a monotone cubic. Velocity carries through every waypoint, and the path never overshoots one: turning points and flat stretches stay put, like Blender's clamped handles.
- **Pacing:** `pacing: "even"` (the default) keeps the speed steady along the path, and `"equal"` gives each stretch the same time.
- **Default length:** 700 ms plus 400 ms per waypoint.
- **Export:** each leg is a cubic-bezier ease per axis. Flair and Lottie take one ease per transform, so those exports sample the path.
- **New exports:** `smoothMotionLegs` and `smoothMotionTimes`.
