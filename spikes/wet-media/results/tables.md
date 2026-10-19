### Steps per second

| Canvas | Wet (tiles dispatched) | WebGPU | wasm SIMD | TypeScript | GPU ÷ wasm |
|---|---|---|---|---|---|
| 1024² | 10% (2/16) | 25937 (0.04 ms) | 1526 (0.66 ms) | 87 (11.43 ms) | 17.0× |
| 1024² | 50% (8/16) | 3285 (0.30 ms) | 1196 (0.84 ms) | 21 (46.94 ms) | 2.7× |
| 1024² | 100% (16/16) | 1626 (0.61 ms) | 659 (1.52 ms) | 11 (91.20 ms) | 2.5× |
| 2048² | 10% (6/64) | 4681 (0.21 ms) | 1301 (0.77 ms) | 28 (36.30 ms) | 3.6× |
| 2048² | 50% (32/64) | 807 (1.24 ms) | 344 (2.91 ms) | 5.04 (198.37 ms) | 2.3× |
| 2048² | 100% (64/64) | 402 (2.49 ms) | 185 (5.41 ms) | 2.65 (377.50 ms) | 2.2× |
| 4096² | 10% (25/256) | 1006 (0.99 ms) | 432 (2.32 ms) | 4.42 (226.36 ms) | 2.3× |
| 4096² | 50% (128/256) | 198 (5.05 ms) | 99 (10.15 ms) | 0.83 (1208.80 ms) | 2.0× |
| 4096² | 100% (256/256) | 101 (9.85 ms) | 37 (27.01 ms) | 0.40 (2502.16 ms) | 2.7× |

### Cell throughput (million cell-steps per second, active cells only)

| Canvas | Wet | WebGPU | wasm SIMD | TypeScript |
|---|---|---|---|---|
| 1024² | 10% | 3400 | 200 | 11 |
| 1024² | 50% | 1722 | 627 | 11 |
| 1024² | 100% | 1705 | 691 | 11 |
| 2048² | 10% | 1841 | 511 | 11 |
| 2048² | 50% | 1692 | 721 | 11 |
| 2048² | 100% | 1686 | 775 | 11 |
| 4096² | 10% | 1648 | 707 | 7 |
| 4096² | 50% | 1661 | 826 | 7 |
| 4096² | 100% | 1703 | 621 | 7 |

### Memory and load while stepping

| Run | Sim state (MB) | Renderer RSS max (MB) | GPU-process RSS max (MB) | Renderer CPU avg % | GPU-process CPU avg % | GPU util avg / max % |
|---|---|---|---|---|---|---|
| WebGPU 1024² 10% | 120 | 460 | 165 | 7 | 21 | 98 / 98 |
| WebGPU 1024² 50% | 120 | 451 | 158 | 6 | 13 | 99 / 99 |
| WebGPU 1024² 100% | 120 | 452 | 155 | 5 | 9 | 99 / 99 |
| WebGPU 2048² 10% | 480 | 475 | 168 | 6 | 12 | 98 / 99 |
| WebGPU 2048² 50% | 480 | 475 | 173 | 3 | 6 | 99 / 99 |
| WebGPU 2048² 100% | 480 | 476 | 165 | 2 | 5 | 99 / 100 |
| WebGPU 4096² 10% | 1920 | 352 | 138 | 3 | 7 | 99 / 99 |
| WebGPU 4096² 50% | 1920 | 572 | 210 | 1 | 4 | 99 / 99 |
| WebGPU 4096² 100% | 1920 | 573 | 208 | 1 | 4 | 99 / 99 |
| wasm SIMD 1024² 10% | 20 | 529 | 135 | 230 | 1 | 13 / 15 |
| wasm SIMD 1024² 50% | 67 | 577 | 136 | 665 | 1 | 13 / 16 |
| wasm SIMD 1024² 100% | 130 | 634 | 137 | 816 | 1 | 13 / 17 |
| wasm SIMD 2048² 10% | 63 | 587 | 137 | 529 | 1 | 12 / 14 |
| wasm SIMD 2048² 50% | 268 | 780 | 135 | 947 | 2 | 13 / 15 |
| wasm SIMD 2048² 100% | 520 | 1023 | 133 | 964 | 2 | 13 / 14 |
| wasm SIMD 4096² 10% | 261 | 863 | 133 | 902 | 1 | 12 / 13 |
| wasm SIMD 4096² 50% | 1072 | 1626 | 126 | 1048 | 1 | 12 / 13 |
| wasm SIMD 4096² 100% | 2079 | 2241 | 91 | 743 | 0 | 35 / 42 |
| TypeScript 1024² 10% | 116 | 482 | 112 | 100 | 2 | 20 / 23 |
| TypeScript 1024² 50% | 116 | 514 | 116 | 99 | 2 | 17 / 21 |
| TypeScript 1024² 100% | 116 | 565 | 113 | 99 | 2 | 16 / 19 |
| TypeScript 2048² 10% | 464 | 636 | 112 | 98 | 2 | 18 / 24 |
| TypeScript 2048² 50% | 464 | 690 | 115 | 98 | 1 | 19 / 41 |
| TypeScript 2048² 100% | 464 | 918 | 115 | 100 | 1 | 20 / 22 |
| TypeScript 4096² 10% | 1856 | 1078 | 115 | 100 | 2 | 17 / 18 |
| TypeScript 4096² 50% | 1856 | 1278 | 107 | 99 | 1 | 19 / 28 |
| TypeScript 4096² 100% | 1856 | 2192 | 102 | 99 | 0 | 16 / 18 |

Adapter: apple metal-3; limits {"maxStorageBufferBindingSize":4294967292,"maxBufferSize":4294967292,"maxStorageBuffersPerShaderStage":10}

### Dab to pixels (64 px dab, then 1 step, then present the dab tiles)

| Impl | Canvas | Rest of canvas | First dab (ms) | Median of next 8 (ms) | Max (ms) |
|---|---|---|---|---|---|
| WebGPU | 1024² | dry | 5.9 | 2.5 | 338.9 |
| WebGPU | 1024² | 50% wet (14 tiles active at end) | 1.6 | 1.8 | 3.8 |
| WebGPU | 2048² | dry | 13.1 | 2.7 | 3.3 |
| WebGPU | 2048² | 50% wet (48 tiles active at end) | 3.3 | 3.7 | 4.7 |
| WebGPU | 4096² | dry | 228.1 | 12.5 | 44.4 |
| WebGPU | 4096² | 50% wet (164 tiles active at end) | 10.3 | 13.4 | 36.0 |
| wasm SIMD | 1024² | dry | 11.5 | 3.5 | 7.4 |
| wasm SIMD | 1024² | 50% wet (14 tiles active at end) | 5.3 | 3.7 | 5.7 |
| wasm SIMD | 2048² | dry | 6.4 | 5.1 | 8.3 |
| wasm SIMD | 2048² | 50% wet (48 tiles active at end) | 6.1 | 7.0 | 10.8 |
| wasm SIMD | 4096² | dry | 8.5 | 6.9 | 7.8 |
| wasm SIMD | 4096² | 50% wet (164 tiles active at end) | 15.2 | 19.4 | 19.6 |
| TypeScript | 1024² | dry | 42.1 | 52.5 | 57.1 |
| TypeScript | 1024² | 50% wet (14 tiles active at end) | 63.5 | 79.1 | 85.6 |
| TypeScript | 2048² | dry | 21.6 | 65.2 | 87.2 |
| TypeScript | 2048² | 50% wet (48 tiles active at end) | 217.1 | 274.9 | 290.7 |
| TypeScript | 4096² | dry | 72.6 | 191.3 | 274.3 |
| TypeScript | 4096² | 50% wet (164 tiles active at end) | 1255.0 | 1409.4 | 1461.8 |

### wasm worker scaling (2048², 100% wet, 14 logical cores)

| Workers | ms / step | steps / s | speed-up vs 1 |
|---|---|---|---|
| 1 | 41.46 | 24.1 | 1.00× |
| 2 | 21.19 | 47.2 | 1.96× |
| 4 | 11.04 | 90.6 | 3.76× |
| 6 | 7.84 | 127.6 | 5.29× |
| 8 | 6.11 | 163.6 | 6.78× |
| 10 | 5.47 | 182.8 | 7.58× |
| 12 | 5.63 | 177.5 | 7.36× |
| 14 | 5.46 | 183.2 | 7.60× |
| ts | 378.29 | 2.6 | 0.11× |

### Divergence from the TypeScript reference (512², 500 steps, flow map + tilt, 6 dabs)

| Impl | Step | water max abs | water rel RMS | pigment (suspended) max abs | deposit max abs | RGBA8 wet: max Δ / % px | RGBA8 dried: max Δ / % px |
|---|---|---|---|---|---|---|---|
| wasm SIMD (14 workers) | 100 | 2.9e-6 | 2.6e-6 | 1.1e-6 | 3.4e-7 | 1 / 0.001 | 1 / 0.001 |
| wasm SIMD (14 workers) | 200 | 1.9e-6 | 2.6e-6 | 8.8e-7 | 8.3e-7 | 1 / 0.002 | 1 / 0.002 |
| wasm SIMD (14 workers) | 300 | 1.3e-6 | 2.1e-6 | 7.2e-7 | 1.3e-6 | 1 / 0.001 | 1 / 0.000 |
| wasm SIMD (14 workers) | 400 | 1.2e-6 | 2.7e-6 | 7.3e-7 | 1.6e-6 | 1 / 0.001 | 1 / 0.001 |
| wasm SIMD (14 workers) | 500 | 1.1e-6 | 2.9e-6 | 8.6e-7 | 1.7e-6 | 1 / 0.000 | 1 / 0.000 |
| WebGPU | 100 | 1.4e-6 | 2.2e-6 | 7.5e-7 | 2.5e-7 | 1 / 0.000 | 0 / 0.000 |
| WebGPU | 200 | 1.8e-6 | 3.9e-6 | 4.8e-7 | 8.3e-7 | 1 / 0.001 | 1 / 0.000 |
| WebGPU | 300 | 2.2e-6 | 4.8e-6 | 5.2e-7 | 1.1e-6 | 1 / 0.001 | 1 / 0.000 |
| WebGPU | 400 | 2.3e-6 | 7.8e-6 | 5.2e-7 | 1.2e-6 | 1 / 0.002 | 0 / 0.000 |
| WebGPU | 500 | 2.5e-6 | 1.1e-5 | 7.7e-7 | 1.3e-6 | 1 / 0.001 | 1 / 0.000 |

State hashes at step 500 (FNV-1a of the f32 planes and of the dried RGBA8):

| Run | State | Dried RGBA8 |
|---|---|---|
| TypeScript | `e1c8003f1a5f2236bcc95b4c` | `98a5bbf7` |
| wasm SIMD (14 workers) | `276867b8e97d13108f5c61bb` | `f48456f7` |
| wasm SIMD (1 worker) | `276867b8e97d13108f5c61bb` | `f48456f7` |
| WebGPU | `b662c73e65120a0c488c7b58` | `51e69246` |
| WebGPU | `b662c73e65120a0c488c7b58` | `51e69246` |

Conservation with evaporation and absorption off (300 steps):

| Impl | Water drift | Pigment drift |
|---|---|---|
| TypeScript | 1.2e-9 | -4.5e-9 |
| wasm SIMD (14 workers) | 4.1e-6 | 5.3e-9 |
| WebGPU | 3.4e-6 | 4.4e-10 |

Run time of the 500-step check: TypeScript 16.66 s, wasm SIMD (14 workers) 0.46 s, wasm SIMD (1 worker) 1.34 s, WebGPU 0.18 s, WebGPU 0.18 s
