import CoreGraphics
import Foundation
import PixerateChart
import SwiftUI

/// Parses an SVG path `d` attribute (`M`, `L`, `H`, `V`, `C`, `S`, `Q`, `T`, `A`, `Z` and relative
/// lowercase commands) into a `CGPath`.
public func parseChartCGPath(_ d: String) -> CGPath {
    let path = CGMutablePath()
    let tokens = tokenizeSvgPath(d)
    var i = 0
    var curX = 0.0
    var curY = 0.0
    var startX = 0.0
    var startY = 0.0
    var lastCtrlX = 0.0
    var lastCtrlY = 0.0
    var lastCmd: Character = " "

    func nextNum() -> Double? {
        guard i < tokens.count, case .number(let v) = tokens[i] else { return nil }
        i += 1
        return v
    }

    var cmd: Character = " "
    while i < tokens.count {
        if case .command(let c) = tokens[i] {
            cmd = c
            i += 1
        } else if cmd == " " {
            break
        }

        let isRel = cmd.isLowercase
        let upper = Character(cmd.uppercased())

        switch upper {
        case "M":
            guard let x0 = nextNum(), let y0 = nextNum() else { break }
            curX = isRel ? curX + x0 : x0
            curY = isRel ? curY + y0 : y0
            startX = curX
            startY = curY
            path.move(to: CGPoint(x: curX, y: curY))
            lastCtrlX = curX
            lastCtrlY = curY
            lastCmd = cmd
            cmd = isRel ? "l" : "L"
        case "L":
            guard let x0 = nextNum(), let y0 = nextNum() else { break }
            curX = isRel ? curX + x0 : x0
            curY = isRel ? curY + y0 : y0
            path.addLine(to: CGPoint(x: curX, y: curY))
            lastCtrlX = curX
            lastCtrlY = curY
            lastCmd = cmd
        case "H":
            guard let x0 = nextNum() else { break }
            curX = isRel ? curX + x0 : x0
            path.addLine(to: CGPoint(x: curX, y: curY))
            lastCtrlX = curX
            lastCtrlY = curY
            lastCmd = cmd
        case "V":
            guard let y0 = nextNum() else { break }
            curY = isRel ? curY + y0 : y0
            path.addLine(to: CGPoint(x: curX, y: curY))
            lastCtrlX = curX
            lastCtrlY = curY
            lastCmd = cmd
        case "C":
            guard let x1 = nextNum(), let y1 = nextNum(),
                  let x2 = nextNum(), let y2 = nextNum(),
                  let x = nextNum(), let y = nextNum() else { break }
            let cp1x = isRel ? curX + x1 : x1
            let cp1y = isRel ? curY + y1 : y1
            let cp2x = isRel ? curX + x2 : x2
            let cp2y = isRel ? curY + y2 : y2
            curX = isRel ? curX + x : x
            curY = isRel ? curY + y : y
            path.addCurve(
                to: CGPoint(x: curX, y: curY),
                control1: CGPoint(x: cp1x, y: cp1y),
                control2: CGPoint(x: cp2x, y: cp2y)
            )
            lastCtrlX = cp2x
            lastCtrlY = cp2y
            lastCmd = cmd
        case "S":
            guard let x2 = nextNum(), let y2 = nextNum(),
                  let x = nextNum(), let y = nextNum() else { break }
            let prevUpper = Character(lastCmd.uppercased())
            let cp1x = (prevUpper == "C" || prevUpper == "S") ? (2.0 * curX - lastCtrlX) : curX
            let cp1y = (prevUpper == "C" || prevUpper == "S") ? (2.0 * curY - lastCtrlY) : curY
            let cp2x = isRel ? curX + x2 : x2
            let cp2y = isRel ? curY + y2 : y2
            curX = isRel ? curX + x : x
            curY = isRel ? curY + y : y
            path.addCurve(
                to: CGPoint(x: curX, y: curY),
                control1: CGPoint(x: cp1x, y: cp1y),
                control2: CGPoint(x: cp2x, y: cp2y)
            )
            lastCtrlX = cp2x
            lastCtrlY = cp2y
            lastCmd = cmd
        case "Q":
            guard let x1 = nextNum(), let y1 = nextNum(),
                  let x = nextNum(), let y = nextNum() else { break }
            let cpx = isRel ? curX + x1 : x1
            let cpy = isRel ? curY + y1 : y1
            curX = isRel ? curX + x : x
            curY = isRel ? curY + y : y
            path.addQuadCurve(to: CGPoint(x: curX, y: curY), control: CGPoint(x: cpx, y: cpy))
            lastCtrlX = cpx
            lastCtrlY = cpy
            lastCmd = cmd
        case "T":
            guard let x = nextNum(), let y = nextNum() else { break }
            let prevUpper = Character(lastCmd.uppercased())
            let cpx = (prevUpper == "Q" || prevUpper == "T") ? (2.0 * curX - lastCtrlX) : curX
            let cpy = (prevUpper == "Q" || prevUpper == "T") ? (2.0 * curY - lastCtrlY) : curY
            curX = isRel ? curX + x : x
            curY = isRel ? curY + y : y
            path.addQuadCurve(to: CGPoint(x: curX, y: curY), control: CGPoint(x: cpx, y: cpy))
            lastCtrlX = cpx
            lastCtrlY = cpy
            lastCmd = cmd
        case "A":
            guard let rx = nextNum(), let ry = nextNum(),
                  let xAxisRot = nextNum(),
                  let largeArcFlag = nextNum(),
                  let sweepFlag = nextNum(),
                  let x = nextNum(), let y = nextNum() else { break }
            let endX = isRel ? curX + x : x
            let endY = isRel ? curY + y : y
            addSvgArc(
                to: path,
                x1: curX,
                y1: curY,
                rx: rx,
                ry: ry,
                phiDegrees: xAxisRot,
                largeArc: largeArcFlag != 0,
                sweep: sweepFlag != 0,
                x2: endX,
                y2: endY
            )
            curX = endX
            curY = endY
            lastCtrlX = curX
            lastCtrlY = curY
            lastCmd = cmd
        case "Z":
            path.closeSubpath()
            curX = startX
            curY = startY
            lastCtrlX = curX
            lastCtrlY = curY
            lastCmd = cmd
            cmd = " "
        default:
            i += 1
        }
    }
    return path
}

public func parseChartPath(_ d: String) -> Path {
    Path(parseChartCGPath(d))
}

private enum SvgPathToken {
    case command(Character)
    case number(Double)
}

private func tokenizeSvgPath(_ d: String) -> [SvgPathToken] {
    var out: [SvgPathToken] = []
    let chars = Array(d.utf8)
    let n = chars.count
    var i = 0
    while i < n {
        let b = chars[i]
        if b == 0x20 || b == 0x09 || b == 0x0A || b == 0x0D || b == 0x2C {
            i += 1
            continue
        }
        if (b >= 0x41 && b <= 0x5A && b != 0x45) || (b >= 0x61 && b <= 0x7A && b != 0x65) {
            out.append(.command(Character(UnicodeScalar(b))))
            i += 1
            continue
        }
        let start = i
        if b == 0x2B || b == 0x2D { i += 1 }
        var seenDot = false
        while i < n {
            let c = chars[i]
            if c >= 0x30 && c <= 0x39 {
                i += 1
            } else if c == 0x2E && !seenDot {
                seenDot = true
                i += 1
            } else {
                break
            }
        }
        if i < n && (chars[i] == 0x65 || chars[i] == 0x45) {
            i += 1
            if i < n && (chars[i] == 0x2B || chars[i] == 0x2D) { i += 1 }
            while i < n && chars[i] >= 0x30 && chars[i] <= 0x39 { i += 1 }
        }
        if i > start, let str = String(bytes: chars[start..<i], encoding: .utf8), let val = Double(str) {
            out.append(.number(val))
        } else {
            i += 1
        }
    }
    return out
}

/// Converts an SVG endpoint-parameterized elliptical arc into cubic Bézier curves on `path`
/// (W3C SVG 1.1 Appendix F.6.5–F.6.6).
private func addSvgArc(
    to path: CGMutablePath,
    x1: Double,
    y1: Double,
    rx rawRx: Double,
    ry rawRy: Double,
    phiDegrees: Double,
    largeArc: Bool,
    sweep: Bool,
    x2: Double,
    y2: Double
) {
    if x1 == x2 && y1 == y2 { return }
    var rx = abs(rawRx)
    var ry = abs(rawRy)
    if rx == 0 || ry == 0 {
        path.addLine(to: CGPoint(x: x2, y: y2))
        return
    }
    let phi = phiDegrees * .pi / 180.0
    let cosPhi = cos(phi)
    let sinPhi = sin(phi)
    let dx2 = (x1 - x2) / 2.0
    let dy2 = (y1 - y2) / 2.0
    let x1p = cosPhi * dx2 + sinPhi * dy2
    let y1p = -sinPhi * dx2 + cosPhi * dy2

    let rx2 = rx * rx
    let ry2 = ry * ry
    let x1p2 = x1p * x1p
    let y1p2 = y1p * y1p
    let lambda = x1p2 / rx2 + y1p2 / ry2
    if lambda > 1.0 {
        let s = sqrt(lambda)
        rx *= s
        ry *= s
    }
    let rxSq = rx * rx
    let rySq = ry * ry
    let num = Swift.max(0.0, rxSq * rySq - rxSq * y1p2 - rySq * x1p2)
    let den = rxSq * y1p2 + rySq * x1p2
    let factor = (largeArc == sweep ? -1.0 : 1.0) * (den > 0 ? sqrt(num / den) : 0.0)
    let cxp = factor * (rx * y1p / ry)
    let cyp = factor * (-ry * x1p / rx)
    let cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2.0
    let cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2.0

    func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double {
        let dot = ux * vx + uy * vy
        let len = sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
        guard len > 0 else { return 0 }
        let c = Swift.max(-1.0, Swift.min(1.0, dot / len))
        let a = acos(c)
        return (ux * vy - uy * vx) < 0 ? -a : a
    }

    let ux = (x1p - cxp) / rx
    let uy = (y1p - cyp) / ry
    let vx = (-x1p - cxp) / rx
    let vy = (-y1p - cyp) / ry
    let theta1 = angle(1.0, 0.0, ux, uy)
    var dTheta = angle(ux, uy, vx, vy)
    if !sweep && dTheta > 0 { dTheta -= 2.0 * .pi }
    if sweep && dTheta < 0 { dTheta += 2.0 * .pi }

    let segments = Swift.max(1, Int(ceil(abs(dTheta) / (.pi / 2.0))))
    let delta = dTheta / Double(segments)
    let alpha = (4.0 / 3.0) * tan(delta / 4.0)

    for s in 0..<segments {
        let t1 = theta1 + Double(s) * delta
        let t2 = t1 + delta
        let cos1 = cos(t1), sin1 = sin(t1)
        let cos2 = cos(t2), sin2 = sin(t2)
        let p1x = rx * (cos1 - alpha * sin1)
        let p1y = ry * (sin1 + alpha * cos1)
        let p2x = rx * (cos2 + alpha * sin2)
        let p2y = ry * (sin2 - alpha * cos2)
        let ex = rx * cos2
        let ey = ry * sin2
        path.addCurve(
            to: CGPoint(x: cosPhi * ex - sinPhi * ey + cx, y: sinPhi * ex + cosPhi * ey + cy),
            control1: CGPoint(x: cosPhi * p1x - sinPhi * p1y + cx, y: sinPhi * p1x + cosPhi * p1y + cy),
            control2: CGPoint(x: cosPhi * p2x - sinPhi * p2y + cx, y: sinPhi * p2x + cosPhi * p2y + cy)
        )
    }
}
