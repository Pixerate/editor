// The wet-media step of `PixeratePaint` (`wetStepSlot` in WetKernel.swift) on four cells at a time,
// as the TS core's WebAssembly kernel (packages/core/assembly/wet.ts) does: every operation is the
// scalar kernel's, in its order, per lane, and branches become bitwise selects (both sides are
// computed, the unused one dropped). It gives the scalar kernel's bits (`WetKernelTests`).
//
// C, not Swift: the Swift compiler turns SIMD masks and selects into lane-by-lane code, which ran
// slower than the scalar kernel. Contraction is off, so no multiply-add is ever fused (the TS
// kernel rounds every operation).

#pragma clang fp contract(off)

#include <string.h>
#include "PixerateWetKernel.h"

typedef float v4 __attribute__((ext_vector_type(4)));
typedef int32_t m4 __attribute__((ext_vector_type(4)));
typedef uint32_t u4 __attribute__((ext_vector_type(4)));

static inline v4 ld(const float *p) {
    v4 v;
    memcpy(&v, p, sizeof v);
    return v;
}
static inline void st(float *p, v4 v) { memcpy(p, &v, sizeof v); }
static inline v4 sp(float x) { return (v4){x, x, x, x}; }
/// `a` where `m` (all-ones lanes), else `b`.
static inline v4 sel(v4 a, v4 b, m4 m) { return (v4)(((u4)a & (u4)m) | ((u4)b & ~(u4)m)); }
/// `Math.max` per lane: NaN wins; +0 over −0.
static inline v4 vmax(v4 a, v4 b) {
    v4 r = sel(a, b, a > b);
    r = sel((v4)((u4)a & (u4)b), r, a == b);
    return sel(sp(__builtin_nanf("")), r, (a != a) | (b != b));
}
/// `Math.min` per lane: NaN wins; −0 over +0.
static inline v4 vmin(v4 a, v4 b) {
    v4 r = sel(a, b, a < b);
    r = sel((v4)((u4)a | (u4)b), r, a == b);
    return sel(sp(__builtin_nanf("")), r, (a != a) | (b != b));
}
static inline int any(m4 m) { return (m.x | m.y | m.z | m.w) != 0; }

uint32_t pixerate_wet_step(float *f, int32_t parity, const float *prm, const PixerateWetLayout *L) {
    const int S = L->side, PL = L->plane, SETP = L->setPlanes * L->plane;
    float *src = f + parity * SETP;
    float *dst = f + (1 - parity) * SETP;
    const float *hP = f + L->pH * PL;
    float *dP = f + L->pD0 * PL;
    const float *rhoS = src + L->pRho * PL;
    const float *uxS = src + L->pUx * PL;
    const float *uyS = src + L->pUy * PL;
    const float *swS = src + L->pSw * PL;
    const float *pS = src + L->pP0 * PL;
    const float *eS = src + L->pEdge * PL;
    const float *fxP = f + L->pFx * PL;
    const float *fyP = f + L->pFy * PL;

    const v4 omega = sp(prm[L->omega]), tau = sp(prm[L->tau]), evap = sp(prm[L->evap]), edgeEvap = sp(prm[L->edgeEvap]);
    const v4 mobility = sp(prm[L->mobility]), depRate = sp(prm[L->depRate]), pickup = sp(prm[L->pickup]), absorption = sp(prm[L->absorption]);
    const v4 invCap = sp(prm[L->invCap]), blockScale = sp(prm[L->blockScale]), rough = sp(prm[L->rough]), pinT = sp(prm[L->pinT]);
    const v4 gx0 = sp(prm[L->gx]), gy0 = sp(prm[L->gy]), flowK = sp(prm[L->flowK]), gran = sp(prm[L->granulation]);
    const v4 edgeDep = sp(prm[L->edgeDep]), bloom = sp(prm[L->bloom]), paperEvap = sp(prm[L->paperEvap]), bleed = sp(prm[L->bleed]);
    const int hasFlow = prm[L->hasFlow] != 0;

    const v4 zero = sp(0), one = sp(1), half = sp(0.5f), quarter = sp(0.25f);
    const v4 eps = sp(L->eps), tiny = sp(L->tiny), decay = sp(L->decay);
    const v4 w0 = sp(L->w0), w1 = sp(L->w1), w2 = sp(L->w2);
    const v4 oneHalf = sp(1.5f), three = sp(3), fourHalf = sp(4.5f);
    const v4 umax = sp(L->umax), umax2 = sp(L->umax2);
    const int T = L->tile;

    uint32_t flags = 0;
    for (int y = 1; y <= T; y++) {
        for (int x = 1; x <= T; x += 4) {
            const int c = y * S + x;
            const v4 rx = ld(rhoS + c);
            const v4 sx = ld(swS + c);
            const u4 rAny = (u4)rx | (u4)sx
                | (u4)ld(rhoS + c - 1) | (u4)ld(rhoS + c + 1)
                | (u4)ld(rhoS + c - S - 1) | (u4)ld(rhoS + c - S) | (u4)ld(rhoS + c - S + 1)
                | (u4)ld(rhoS + c + S - 1) | (u4)ld(rhoS + c + S) | (u4)ld(rhoS + c + S + 1);
            if (!any((m4)rAny)) {
                const u4 pAny = (u4)ld(pS + c) | (u4)ld(pS + PL + c) | (u4)ld(pS + 2 * PL + c) | (u4)ld(pS + 3 * PL + c) | (u4)ld(pS + 4 * PL + c);
                if (!any((m4)pAny)) {
                    for (int k = 0; k < L->setPlanes; k++) st(dst + k * PL + c, zero);
                    continue;
                }
            }
            const v4 hx = ld(hP + c);
            const v4 kx = blockScale * hx;
            const v4 damp = vmax(zero, one - sx * invCap);
            const v4 pinX = (pinT + rough * hx) * damp;
            const m4 rxDry = rx < eps;
            const m4 xWall = hx < zero;

            // 1. streaming with partial bounce-back and pinning (n = x − eₖ)
            v4 dryNb = zero;
#define STREAM(K, OFF, OPP, OUT)                                                                       \
    v4 OUT;                                                                                          \
    {                                                                                                \
        const int n = c + (OFF);                                                                     \
        const v4 hn = ld(hP + n), rn = ld(rhoS + n), sn = ld(swS + n);                               \
        const m4 wall = hn < zero;                                                                   \
        const m4 rnDry = rn < eps;                                                                   \
        const v4 dampN = vmax(zero, one - sn * invCap);                                              \
        dryNb = dryNb + sel(dampN, zero, rnDry & ~wall);                                             \
        v4 b = vmax(kx, blockScale * hn);                                                            \
        const v4 pinN = (pinT + rough * hn) * dampN;                                                 \
        b = sel(one, b, wall | xWall | (rxDry & (rn < pinX)) | (rnDry & (rx < pinN)));               \
        OUT = (one - b) * ld(src + (K) * PL + n) + b * ld(src + (OPP) * PL + c);                     \
    }
            const v4 f0 = ld(src + c);
            STREAM(1, -1, 3, f1)
            STREAM(2, -S, 4, f2)
            STREAM(3, 1, 1, f3)
            STREAM(4, S, 2, f4)
            STREAM(5, -S - 1, 7, f5)
            STREAM(6, -S + 1, 8, f6)
            STREAM(7, S + 1, 5, f7)
            STREAM(8, S - 1, 6, f8)
#undef STREAM

            // 2. depth, velocity, forcing
            const v4 rho = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
            const v4 mx = f1 - f3 + f5 - f6 - f7 + f8;
            const v4 my = f2 - f4 + f5 + f6 - f7 - f8;
            v4 gx = gx0, gy = gy0;
            if (hasFlow) {
                gx = gx + flowK * ld(fxP + c);
                gy = gy + flowK * ld(fyP + c);
            }
            const m4 moving = rho > eps;
            v4 ux = sel(mx / rho + tau * gx, zero, moving);
            v4 uy = sel(my / rho + tau * gy, zero, moving);
            const v4 sp2 = ux * ux + uy * uy;
            const m4 fast = sp2 > umax2;
            const v4 sc = umax / __builtin_elementwise_sqrt(sp2);
            ux = sel(ux * sc, ux, fast);
            uy = sel(uy * sc, uy, fast);

            // 3. absorption and evaporation
            const v4 absorbed = vmin(rho, absorption * (one - half * hx) * rho * damp);
            const v4 ex = ld(eS + c);
            const v4 ev = sel(evap * (one + edgeEvap * ex), zero, rho > zero);
            const v4 rhoNew = vmax(zero, rho - absorbed - ev);
            const v4 scale = sel(rhoNew / rho, zero, rho > tiny);
            const v4 sNew = vmax(zero, sx + absorbed - sel(paperEvap, zero, sx > zero));
            st(dst + L->pSw * PL + c, sNew);

            // 4. collision, then scale
            const v4 usq = oneHalf * (ux * ux + uy * uy);
            const v4 wr0 = w0 * rho, wr1 = w1 * rho, wr2 = w2 * rho;
            st(dst + c, (f0 + omega * (wr0 * (one - usq) - f0)) * scale);
#define COLLIDE(K, FK, WR, EU)                                                                          \
    {                                                                                                \
        const v4 eu = (EU);                                                                          \
        const v4 feq = (WR) * (one + three * eu + fourHalf * eu * eu - usq);                         \
        st(dst + (K) * PL + c, ((FK) + omega * (feq - (FK))) * scale);                               \
    }
            COLLIDE(1, f1, wr1, ux)
            COLLIDE(2, f2, wr1, uy)
            COLLIDE(3, f3, wr1, -ux)
            COLLIDE(4, f4, wr1, -uy)
            COLLIDE(5, f5, wr2, ux + uy)
            COLLIDE(6, f6, wr2, uy - ux)
            COLLIDE(7, f7, wr2, -(ux + uy))
            COLLIDE(8, f8, wr2, ux - uy)
#undef COLLIDE

            // 5. pigment and light: upwind advection with the last step's velocities, plus bleed
            const m4 rxWet = ~rxDry;
            const v4 pc[5] = {ld(pS + c), ld(pS + PL + c), ld(pS + 2 * PL + c), ld(pS + 3 * PL + c), ld(pS + 4 * PL + c)};
            v4 p[5] = {pc[0], pc[1], pc[2], pc[3], pc[4]};
            if (any(rxWet)) {
                const v4 uxc = ld(uxS + c), uyc = ld(uyS + c);
#define FACE(NB, UF, OUT)                                                                               \
    {                                                                                                \
        const int nb = (NB);                                                                         \
        const m4 open = rxWet & (ld(rhoS + nb) >= eps);                                              \
        if (any(open)) {                                                                             \
            const v4 uf = (UF);                                                                      \
            const m4 pos = uf > zero;                                                                \
            for (int q = 0; q < 5; q++) {                                                            \
                const v4 pn = ld(pS + q * PL + nb);                                                  \
                const v4 diff = bleed * (pn - pc[q]);                                                \
                const v4 v = (OUT) ? p[q] - sel(uf * pc[q], uf * pn, pos) + diff : p[q] + sel(uf * pn, uf * pc[q], pos) + diff; \
                p[q] = sel(v, p[q], open);                                                           \
            }                                                                                        \
        }                                                                                            \
    }
                FACE(c + 1, mobility * (uxc + ld(uxS + c + 1)), 1)
                FACE(c - 1, mobility * (ld(uxS + c - 1) + uxc), 0)
                FACE(c + S, mobility * (uyc + ld(uyS + c + S)), 1)
                FACE(c - S, mobility * (ld(uyS + c - S) + uyc), 0)
#undef FACE
            }

            // 6. deposition and pickup
            const m4 dryNow = rhoNew < eps;
            const v4 rate = depRate * (one + gran * (one - hx)) * (one + edgeDep * ex);
            const v4 lift = sel(zero, pickup * vmin(rhoNew, one) * (one + bloom * vmax(zero, rhoNew - rx)), dryNow);
            for (int q = 0; q < 5; q++) {
                const v4 pq = vmax(zero, p[q]);
                const v4 dq = ld(dP + q * PL + c);
                const v4 dep = sel(pq, vmin(pq, pq * rate), dryNow);
                const v4 lq = dq * lift;
                st(dst + (L->pP0 + q) * PL + c, pq - dep + lq);
                st(dP + q * PL + c, dq + dep - lq);
            }
            // the edge field
            const v4 mean4 = (ld(eS + c + 1) + ld(eS + c - 1) + ld(eS + c + S) + ld(eS + c - S)) * quarter;
            const v4 eNew = vmin(one, vmax(vmin(one, dryNb * quarter), decay * mean4));
            st(dst + L->pEdge * PL + c, sel(zero, eNew, dryNow));
            st(dst + L->pRho * PL + c, rhoNew);
            st(dst + L->pUx * PL + c, sel(zero, ux, dryNow));
            st(dst + L->pUy * PL + c, sel(zero, uy, dryNow));
            // STRIP divides by four, so the four lanes share their edge bits.
            if (any((rhoNew > zero) | (sNew > zero))) {
                const int lx = x - 1, ly = y - 1;
                flags |= L->flagAlive;
                if (lx < L->strip) flags |= L->flagLeft;
                if (lx >= T - L->strip) flags |= L->flagRight;
                if (ly < L->strip) flags |= L->flagTop;
                if (ly >= T - L->strip) flags |= L->flagBottom;
            }
            if (any(~dryNow)) flags |= L->flagWet;
        }
    }
    return flags;
}
