// The wet-media step on four cells at a time (clang vector extensions), for `PixeratePaint`.
// See wet_kernel.c.

#ifndef PIXERATE_WET_KERNEL_H
#define PIXERATE_WET_KERNEL_H

#include <stdint.h>

/// The slot layout, constants and parameter indices the step needs, all from `WetModel.swift`.
typedef struct {
    int32_t side, plane, setPlanes, tile, strip;
    int32_t pRho, pUx, pUy, pSw, pP0, pEdge, pD0, pH, pFx, pFy;
    int32_t omega, tau, evap, edgeEvap, mobility, depRate, pickup, absorption, invCap, blockScale;
    int32_t rough, pinT, gx, gy, flowK, granulation, edgeDep, bloom, paperEvap, hasFlow, bleed;
    uint32_t flagAlive, flagLeft, flagRight, flagTop, flagBottom, flagWet;
    float eps, umax, umax2, w0, w1, w2, tiny, decay;
} PixerateWetLayout;

/// One step of the slot at `f` (set `parity`) with the lane's packed parameters `prm`. Returns the tile's flags.
uint32_t pixerate_wet_step(float *f, int32_t parity, const float *prm, const PixerateWetLayout *layout);

#endif
