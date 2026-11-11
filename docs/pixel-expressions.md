# Pixel expressions

A small language for effects written at run time, by a person or an agent. A program runs once
for every pixel and says what colour that pixel is. It has no loops, no functions of its own, no
memory and no access to anything but the pixel's position, the time and the effect's controls, so
every program finishes in a fixed number of steps. The TypeScript core
(`packages/core/src/effects/pixel-language.ts`) is the specification. The Swift package ports the
CPU evaluator and also generates Metal Shading Language from the same program
(`PixelLanguage.swift`, `PixelMSL.swift`).

```
// Rings that spread from a point.
control ink: color = #1d2b53            // Colour of the rings.
control count: number = 12 range 1 64   // Rings across the picture.
control center: vec2 = vec2(0.5, 0.5) range 0 1 // Where they spread from.
let d = distance(uv, center)
let wave = 0.5 + 0.5 * sin((d * count - time / 2) * TAU)
out = vec4(ink, smoothstep(0.4, 0.6, wave))
```

## Lines

Each line is one statement (`;` also ends one). Inside parentheses a statement can run over
several lines. `//` starts a comment.

| Statement                                              |                                                                                                                           |
| :----------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| `control <name>: <type> = <default> [range <lo> <hi>]` | A setting of the effect. All controls come before the first `let`. The comment at the end of the line is its description. |
| `let <name> = <expression>`                            | A named value. Names can't be reused, and can't be a keyword, a built-in value or a function.                             |
| `out = <expression>`                                   | The pixel: a number (grey), a vec3 (an opaque colour) or a vec4 (colour and straight alpha). The last line, exactly once. |

| Control type | Default                                          | Value in a document | In expressions                  |
| :----------- | :----------------------------------------------- | :------------------ | :------------------------------ |
| `number`     | `1`, `-0.5` (with an optional `range`)           | a number            | a number                        |
| `color`      | `#rrggbb`                                        | `"#rrggbb"`         | a vec3, 0..1 per channel (sRGB) |
| `bool`       | `true` or `false`                                | a boolean           | 1 or 0                          |
| `vec2`       | `vec2(x, y)` (with an optional `range` for both) | `[x, y]`            | a vec2                          |

## Values

- Numbers (`1`, `0.5`, `.5`, `2e3`), `#rrggbb` (a vec3) and `#rrggbbaa` (a vec4) colours.
- Vectors: `vec2`, `vec3` and `vec4`. Parts are `.x .y .z .w` or `.r .g .b .a`, and several
  together make a smaller vector (`.xy`, `.rgb`, `.zyx`).
- `+ - * / %` work part by part. A number combines with a vector of any size; two vectors must
  be the same size. `%` is `mod`.
- `< <= > >= == !=` compare two numbers and give 1 or 0. They can't be chained.

| Built in    |                                                                |
| :---------- | :------------------------------------------------------------- |
| `uv`        | vec2: 0..1 across and down from the top left, at pixel centres |
| `pos`       | vec2: pixels from the top left (0.5, 1.5, …)                   |
| `size`      | vec2: the picture's size in pixels                             |
| `time`      | the effect time in seconds                                     |
| `PI`, `TAU` | π and 2π                                                       |

| Functions                                                      |                                                                                                  |
| :------------------------------------------------------------- | :----------------------------------------------------------------------------------------------- |
| `sin cos tan asin acos atan exp log abs sign floor ceil fract` | Part by part                                                                                     |
| `sqrt`                                                         | Part by part; 0 for negatives                                                                    |
| `atan(y, x)`                                                   | The angle of a point                                                                             |
| `pow mod min max step`                                         | Two arguments, part by part (`step(edge, x)` is 0 below `edge`)                                  |
| `clamp(x, lo, hi) mix(a, b, t) smoothstep(lo, hi, x)`          | Three arguments, part by part                                                                    |
| `select(c, a, b)`                                              | `a` where the number `c` > 0.5, else `b`                                                         |
| `length distance dot`                                          | Give a number                                                                                    |
| `normalize`                                                    | Length 1 (a zero vector stays zero)                                                              |
| `hash(p)`                                                      | A random 0..1 for each whole-number cell of a vec2 (an integer hash, the same on every platform) |
| `noise(p)`                                                     | Smooth value noise 0..1 over a vec2 (counts 4 steps)                                             |
| `vec2() vec3() vec4()`                                         | From parts (`vec4(color, 1)`), or one number for every part                                      |

## Output

Each part of `out` is clamped to 0..1 and stored as a byte (`round(v × 255)`); a value that is not
a number (`log(-1)`, `0 / 0`) becomes 0. Colours are sRGB values, not linear light.

## Limits

| Limit                                                                 | Default           |
| :-------------------------------------------------------------------- | :---------------- |
| Source length                                                         | 65,536 characters |
| Steps per pixel (each operator or function call is one; `noise` is 4) | 1,024             |

Errors and warnings come back as issues with a 1-based line and a message that says what to
change. After an error the compiler goes on to the next line, so every bad line is reported once;
lines that only fail because they use a name whose own line failed add nothing. Warnings (an unused
control or `let`) don't stop the program compiling.

## Why it is shaped this way

Effects written at run time have to work where generated code may not run (Apple's App Store
guideline 2.5.2 forbids downloading or executing code that changes an app's features) and must not
hang the GPU. A pixel expression program is data: this package's own code evaluates it, or turns
it into a fixed Metal kernel with no loops. The same source draws the same picture in TypeScript
and Swift, so a painting that uses one replays on any machine.
