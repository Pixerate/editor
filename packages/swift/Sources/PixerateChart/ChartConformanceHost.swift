import Foundation
import PixerateConformance
import PixerateCore
import PixerateRaster

final class ManualChartRaceTicker: @unchecked Sendable {
    var raceClock: Double = 0.0
    var raceQueue: [(id: Int, step: @Sendable () -> Void)] = []
    var nextId: Int = 1

    func now() -> Double { raceClock }

    func next(_ step: @escaping @Sendable () -> Void) -> @Sendable () -> Void {
        let id = nextId
        nextId += 1
        raceQueue.append((id: id, step: step))
        return { [weak self] in
            self?.raceQueue.removeAll { $0.id == id }
        }
    }

    func advance(_ ms: Double = 16.0) {
        raceClock += ms
        let pending = raceQueue
        raceQueue = []
        for item in pending {
            item.step()
        }
    }
}

public final class ChartConformanceHost: ConformanceHost {
    public let controller: ChartController
    public let commands: CommandRegistry<ChartController>
    private let registry = ToolRegistry(validateArguments: true)
    private let ticker = ManualChartRaceTicker()
    private let width: Double
    private let height: Double

    public init(setup: JSONObject) throws {
        clearChartMaps()
        registerChartMap(EUROPE_CHART_MAP)
        if let maps = setup["maps"]?.arrayValue {
            for mVal in maps {
                guard case .object(let m) = mVal,
                      let id = m["id"]?.stringValue,
                      let name = m["name"]?.stringValue else { continue }
                let w = m["width"]?.doubleValue ?? 100.0
                let h = m["height"]?.doubleValue ?? 100.0
                let regions: [ChartMapRegion] = (m["regions"]?.arrayValue ?? []).compactMap { rVal in
                    guard case .object(let r) = rVal,
                          let rid = r["id"]?.stringValue,
                          let rname = r["name"]?.stringValue else { return nil }
                    let d = r["d"]?.stringValue ?? ""
                    let cArr = r["center"]?.arrayValue
                    let cx = cArr?.first?.doubleValue ?? 0.0
                    let cy = (cArr?.count ?? 0) > 1 ? (cArr?[1].doubleValue ?? 0.0) : 0.0
                    let area = r["area"]?.doubleValue ?? 1.0
                    return ChartMapRegion(id: rid, name: rname, d: d, center: (cx, cy), area: area)
                }
                registerChartMap(ChartMapGeometry(
                    id: id,
                    name: name,
                    width: w,
                    height: h,
                    regions: regions,
                    land: m["land"]?.stringValue,
                    attribution: m["attribution"]?.stringValue
                ))
            }
        }

        self.width = setup["width"]?.doubleValue ?? 640.0
        self.height = setup["height"]?.doubleValue ?? 400.0
        let initialSpec = setup["spec"]
        let tickerBox = self.ticker
        let raceTicker = ChartRaceTicker(
            now: { tickerBox.now() },
            next: { step in tickerBox.next(step) }
        )

        self.controller = ChartController(
            ChartControllerOptions(
                spec: initialSpec,
                raceTicker: raceTicker,
                measureText: estimateChartTextWidth
            )
        )

        // `setup.style || setup.brand ? { 'house/SKILL.md', 'house/chart.json'?, 'house/brand.json'? } : {}`
        // in one `org` layer: a truthy style or brand is a skill, and each profile is validated as
        // `createStyleResolver` does.
        func truthy(_ value: JSONValue?) -> JSONValue? {
            switch value {
            case nil, .null?, .bool(false)?, .string("")?: return nil
            case .number(let n)? where n == 0 || n.isNaN: return nil
            case let raw?: return raw
            }
        }
        let styleJson = truthy(setup["style"])
        let brandJson = truthy(setup["brand"])
        let style: ChartStyleResolver = styleJson == nil && brandJson == nil
            ? ChartStyleResolver()
            : ChartStyleResolver(skill: "house", layer: "org", chartJson: styleJson, brandJson: brandJson)

        self.commands = CommandRegistry(context: controller, history: controller.history)
        try commands.register(createChartCommands(controller))

        let readOnlyVal = setup["readOnly"]
        let readOnlyFn: (() -> Any)? = readOnlyVal.map { val in
            return {
                switch val {
                case .bool(let b): return b
                case .string(let s): return s
                default: return false
                }
            }
        }

        // `decodeBase64Bytes` in `chart/contract.ts`: a `data:` prefix and white space are stripped, and
        // `atob` throws on anything else that is not base64.
        func decode(_ b64: String) throws -> [UInt8] {
            guard let bytes = jsDecodeBase64DataUrl(b64) else {
                throw ToolExecutionError("The string to be decoded is not correctly encoded.")
            }
            return bytes
        }
        var openFiles: [OfficeChartFile] = []
        if let rawFiles = setup["files"] {
            switch rawFiles {
            case .array(let arr):
                for item in arr {
                    guard let obj = item.objectValue,
                          let name = obj["name"]?.stringValue,
                          let b64 = obj["data"]?.stringValue else { continue }
                    openFiles.append(OfficeChartFile(name: name, data: try decode(b64)))
                }
            case .object(let obj):
                for (name, val) in obj {
                    guard let b64 = val.stringValue else { continue }
                    openFiles.append(OfficeChartFile(name: name, data: try decode(b64)))
                }
            default:
                break
            }
        }
        let openFilesCopy = openFiles

        _ = try registry.register(createChartToolProvider(
            controller,
            ChartToolProviderOptions(namespace: "", readOnly: readOnlyFn, width: width, height: height)
        ))
        _ = try registry.register(createChartStyleToolProvider(
            controller,
            style,
            ChartStyleToolProviderOptions(namespace: "", readOnly: readOnlyFn)
        ))
        _ = try registry.register(createOfficeChartToolProvider(
            OfficeChartToolProviderOptions(
                namespace: "",
                hasFiles: true,
                files: { openFilesCopy },
                controller: controller,
                readOnly: readOnlyFn
            )
        ))
        _ = try registry.register(createCommandToolProvider(commands, CommandToolProviderOptions(id: "chart-commands", namespace: "")))
    }

    public func advanceRace(_ ms: Double = 16.0) {
        ticker.advance(ms)
    }

    public func callTool(_ name: String, _ args: JSONObject) async -> McpToolResult {
        await registry.callTool(name, args)
    }

    public func document() throws -> JSONValue {
        EditorDocumentFile(
            kind: CHART_DOCUMENT_TYPE,
            formatVersion: CHART_SPEC_VERSION,
            document: controller.toJSON().toJSON()
        ).json
    }

    public func pixels(paper: Bool?) throws -> ConformanceImage {
        throw ContractError("The chart conformance host has no pixels; compare its document, results, render data and SVG export.")
    }

    public func render() throws -> JSONValue? {
        let state = controller.getState()
        return layoutChart(
            controller.toJSON(),
            ChartLayoutOptions(
                width: width,
                height: height,
                selection: state.selection,
                measureText: estimateChartTextWidth,
                raceFrame: state.raceFrame
            )
        ).toJSON()
    }

    public func isGeneratedId(_ value: String) -> Bool {
        false
    }
}
