import Foundation
import PixerateCore
import PixerateRaster

public func canDragChartPoint(_ controller: ChartController, _ scene: ChartScene, _ target: ChartSelection?) -> Bool {
    canDragChartPoint(controller.getSpec(), scene, target)
}

public struct ChartPointDrag {
    public let valueDomain: (min: Double, max: Double)
    public let valueDomain2: (min: Double, max: Double)?
    public let xDomain: (min: Double, max: Double)?
    public let target: (seriesId: String, index: Int)
    public let move: (_ point: (x: Double, y: Double), _ options: ChartDragMoveOptions) -> Void
    public let end: () -> Void
    public let cancel: () -> Void
}

public func startChartPointDrag(
    _ controller: ChartController,
    _ scene: ChartScene,
    _ target: ChartSelection?,
    _ start: (x: Double, y: Double),
    step: Double? = nil,
    tolerancePx: Double? = nil
) -> ChartPointDrag? {
    guard canDragChartPoint(controller, scene, target),
          case .point(let seriesId, let index) = target,
          let series = controller.getSeries(seriesId) else {
        return nil
    }
    let spec = controller.getSpec()
    let secondary = series.axis == .secondary && scene.valueScale2 != nil
    guard let scale = secondary ? scene.valueScale2 : scene.valueScale else { return nil }
    let xy = chartFamily(spec) == .xy && scene.xScale != nil
    let startValue = (index >= 0 && index < series.values.count ? series.values[index] : nil) ?? 0.0
    let startX: Double? = (series.x != nil && index >= 0 && index < series.x!.count) ? series.x![index] : nil
    guard let startAt = chartValueAtPoint(scene, start, secondary) else { return nil }
    let startAtX: Double? = xy ? chartXAtPoint(scene, start) : nil

    var candidates: [Double] = [0.0, startValue]
    if !xy {
        for s in spec.series where s.id != seriesId && !(s.hidden ?? false) && (s.axis == .secondary) == secondary {
            let v = (index >= 0 && index < s.values.count ? s.values[index] : nil) ?? .nan
            candidates.append(v)
        }
        let prev = (index - 1 >= 0 && index - 1 < series.values.count ? series.values[index - 1] : nil) ?? .nan
        let next = (index + 1 >= 0 && index + 1 < series.values.count ? series.values[index + 1] : nil) ?? .nan
        candidates.append(prev)
        candidates.append(next)
    }

    controller.beginGesture("drag:\(seriesId):\(index)")
    var ended = false
    let vDom = scene.valueScale!.domain
    let vDom2 = scene.valueScale2.map { (min: $0.domain.0, max: $0.domain.1) }
    let xDom = xy ? scene.xScale.map { (min: $0.domain.0, max: $0.domain.1) } : nil
    let label = "Drag \(series.name)"

    return ChartPointDrag(
        valueDomain: (min: vDom.0, max: vDom.1),
        valueDomain2: vDom2,
        xDomain: xDom,
        target: (seriesId: seriesId, index: index),
        move: { point, moveOptions in
            if ended { return }
            guard let at = chartValueAtPoint(scene, point, secondary) else { return }
            let factor = (moveOptions.fine == true) ? 0.1 : 1.0
            func moved(_ from: Double, _ to: Double, _ s: ChartValueScale, _ value: Double) -> Double {
                if let logBase = s.logBase, logBase != 0, value > 0, from > 0, to > 0 {
                    return value * pow(to / from, factor)
                }
                return value + (to - from) * factor
            }
            var moveY = true
            var moveX = false
            var atX: Double? = nil
            if xy, startX != nil, startAtX != nil {
                atX = chartXAtPoint(scene, point)
                moveX = atX != nil
                if moveOptions.lockAxis == true {
                    if abs(point.x - start.x) >= abs(point.y - start.y) {
                        moveY = false
                    } else {
                        moveX = false
                    }
                }
            }
            func snap(_ v: Double, _ s: ChartValueScale, _ c: [Double]) -> Double {
                if moveOptions.noSnap == true {
                    return Double(jsToPrecision(v, 12)) ?? v
                }
                if moveOptions.fine == true {
                    if let logBase = s.logBase, logBase != 0, step == nil {
                        return v > 0 ? (Double(jsToPrecision(v, 3)) ?? v) : v
                    }
                    let unit: Double? = step != nil ? step! / 10.0 : (s.ticks.count > 1 ? (s.ticks[1] - s.ticks[0]) / 100.0 : nil)
                    return snapChartValue(scene, v, unit, s.ticks)
                }
                return snapChartDragValue(
                    scene,
                    v,
                    ChartSnapOptions(candidates: c, tolerancePx: tolerancePx, step: step, scale: s)
                )
            }
            let y = moveY ? snap(moved(startAt, at, scale, startValue), scale, candidates) : startValue
            if xy, let startX, let startAtX, let xScale = scene.xScale {
                let nextX = (moveX && atX != nil) ? moved(startAtX, atX!, xScale, startX) : startX
                let x = nextX != startX ? snap(nextX, xScale, [0.0, startX]) : startX
                var xs = series.x ?? []
                while xs.count <= index { xs.append(nil) }
                xs[index] = x
                _ = controller.setValue(seriesId, index, .number(y), options: ChartEditOptions(label: label))
                if x != controller.getSeries(seriesId)?.x?[index] {
                    _ = controller.updateSeries(
                        seriesId,
                        JSONObject([("x", .array(xs.map { $0.map(JSONValue.number) ?? .null }))])
                    )
                }
            } else {
                _ = controller.setValue(seriesId, index, .number(y), options: ChartEditOptions(label: label))
            }
        },
        end: {
            if ended { return }
            ended = true
            controller.endGesture()
        },
        cancel: {
            if ended { return }
            ended = true
            controller.cancelGesture()
        }
    )
}

public func handleChartKey(
    _ controller: ChartController,
    _ scene: ChartScene?,
    _ event: ChartKeyInput
) -> Bool {
    if event.metaKey == true || event.ctrlKey == true { return false }
    let state = controller.getState()
    let selection = state.selection
    let spec = state.spec
    let gesture = state.gesture

    switch event.key {
    case "Escape":
        if gesture != nil {
            controller.cancelGesture()
            return true
        }
        guard selection != nil else { return false }
        controller.select(nil)
        return true
    case "Delete", "Backspace":
        if event.altKey == true || selection == nil || selection == .chart { return false }
        _ = controller.deleteSelection()
        return true
    case "ArrowLeft", "ArrowRight":
        if event.altKey == true { return false }
        let n = spec.categories.count
        guard n > 0 else { return false }
        let delta = event.key == "ArrowRight" ? 1 : -1
        switch selection {
        case .point(let seriesId, let index):
            let next = Swift.max(0, Swift.min(n - 1, index + delta))
            controller.select(.point(seriesId: seriesId, index: next))
            return true
        case .category(let index):
            let next = Swift.max(0, Swift.min(n - 1, index + delta))
            controller.select(.category(index: next))
            return true
        default:
            return false
        }
    case "ArrowUp", "ArrowDown":
        guard case .point(let seriesId, let index) = selection,
              scene?.percent != true else { return false }
        let series = controller.getSeries(seriesId)
        let secondary = series?.axis == .secondary
        let scale = (secondary ? scene?.valueScale2 : nil) ?? scene?.valueScale
        let ticks = scale?.ticks ?? []
        let up = event.key == "ArrowUp"
        let current: Double? = (series != nil && index >= 0 && index < series!.values.count) ? series!.values[index] : nil
        if let logBase = scale?.logBase, logBase != 0, let current, current > 0 {
            let power = (event.shiftKey == true) ? 1.0 : ((event.altKey == true) ? 0.01 : 0.1)
            let raw = current * pow(logBase, up ? power : -power)
            let prec = (event.altKey == true) ? 4 : 3
            let next = Double(jsToPrecision(raw, prec)) ?? raw
            _ = controller.nudgeValue(seriesId, index, next - current)
            return true
        }
        let step = ticks.count > 1 ? ticks[1] - ticks[0] : 1.0
        let amount = (event.shiftKey == true) ? step : ((event.altKey == true) ? step / 100.0 : step / 10.0)
        _ = controller.nudgeValue(seriesId, index, amount * (up ? 1.0 : -1.0))
        return true
    default:
        return false
    }
}

public func describeChartSelection(_ controller: ChartController, _ selection: ChartSelection? = nil) -> String {
    describeChartSelection(controller.getSpec(), selection ?? controller.getState().selection)
}
