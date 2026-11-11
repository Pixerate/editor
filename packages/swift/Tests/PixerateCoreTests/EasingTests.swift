import XCTest
@testable import PixerateCore

/// `animation/easing.ts`: expected values from the TS core (`evaluateEasing` under Node).
final class EasingTests: XCTestCase {
    func testMatchesTheTSCore() {
        let cases: [(AnimationEasing?, Double, Double, Double)] = [
            (.named("ease-in-out"), 0.3, 1000, 0.18739590670531253),
            (.named("ease"), 0.5, 1000, 0.802403387584857),
            (.named("ease-in"), 0.7, 1000, 0.5548140325286629),
            (.named("ease-out"), 0.2, 1000, 0.30836606668068683),
            (.named("ease-in-back"), 0.4, 1000, -0.09657485005078242),
            (.named("ease-out-back"), 0.6, 1000, 1.0965748500507824),
            (.named("linear"), 0.37, 1000, 0.37),
            (nil, 0.37, 1000, 0.37),
            (.named("hold"), 0.99, 1000, 0),
            (.named("spring"), 0.25, 1000, 0.8377235854410197),
            (.named("spring-bouncy"), 0.5, 800, 1.0479938977348877),
            (.named("spring-slow"), 0.3, 2000, 0.9414159049709679),
            (.named("elastic"), 0.35, 1000, 0.9558058261758408),
            (.named("ease-in-elastic"), 0.8, 1000, -0.12500000000000014),
            (.named("ease-in-out-elastic"), 0.3, 1000, -0.01562500000000002),
            (.named("ease-in-out-elastic"), 0.7, 1000, 1.015625),
            (.cubicBezier(x1: 0.2, y1: 0, x2: 0, y2: 1), 0.4, 1000, 0.8022835814694338),
            (.spring(stiffness: 200), 0.5, 1000, 1.000179197879563),
            (.spring(stiffness: 100, damping: 40), 0.5, 1000, 0.717828826024847),
            (.spring(stiffness: 100, damping: 20, mass: 1), 0.5, 1000, 0.9595723180054871),
            (.elastic(amplitude: 0.5, period: 0.4, mode: "in-out"), 0.6, 1000, 1.0625),
            (.named("cubic-bezier(0.1, 0.7, 1.0, 0.1)"), 0.5, 1000, 0.41727678305245813),
            (.named("steps(1, end)"), 0.5, 1000, 0),
            (.named("wobbly"), 0.5, 1000, 0.5),
        ]
        for (easing, u, ms, expected) in cases {
            XCTAssertEqual(evaluateEasing(easing, u, durationMs: ms), expected, accuracy: 1e-9, "\(String(describing: easing)) at \(u)")
        }
        XCTAssertEqual(evaluateEasing(.named("ease"), 0), 0)
        XCTAssertEqual(evaluateEasing(.named("ease-out-back"), 1), 1)
    }

    func testTellsUsableEasingsAndRoundTripsJSON() {
        XCTAssertFalse(isAnimationEasing("wobbly"))
        XCTAssertTrue(isAnimationEasing("steps(1)"))
        XCTAssertTrue(isAnimationEasing("CUBIC-BEZIER(0,0,1,1)"))
        XCTAssertFalse(isAnimationEasing(["type": "cubic-bezier", "x1": 0]))
        XCTAssertTrue(isAnimationEasing(["type": "spring"]))
        XCTAssertFalse(isAnimationEasing("cubic-bezier(1.5,0,1,1)"))
        XCTAssertFalse(isAnimationEasing(5))

        let spring: JSONValue = ["type": "spring", "stiffness": 200]
        XCTAssertEqual(AnimationEasing(json: spring), .spring(stiffness: 200))
        XCTAssertEqual(AnimationEasing(json: spring)?.json.stringified(), #"{"type":"spring","stiffness":200}"#)
        let bezier: JSONValue = ["type": "cubic-bezier", "x1": 0.2, "y1": 0, "x2": 0, "y2": 1]
        XCTAssertEqual(AnimationEasing(json: bezier)?.json, bezier)
        XCTAssertEqual(AnimationEasing(json: "ease-in")?.json, "ease-in")
        XCTAssertNil(AnimationEasing(json: "wobbly"))
        XCTAssertEqual(parseCssEasing("step-end"), .named("hold"))
        XCTAssertEqual(easingLabel(.named("spring-quick")), "Spring (quick)")
        XCTAssertEqual(springSettleMs(stiffness: 170, damping: 26), 531)
    }
}
