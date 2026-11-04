import Foundation
import PixerateRaster
#if canImport(Metal)
import Metal
#endif

/**
 * Metal shading of wet paint for display: the Swift counterpart of the TS core's WebGPU engine
 * ("Engine B", `paint/wet/gpu.ts`), on Apple's shared CPU / GPU memory.
 *
 * The CPU engine (`WetWorld`) stays the authority: it runs every step and every edit, and saving,
 * export and replay read only its bake. Unlike the web, the GPU keeps no copy of the state and runs
 * no steps. Each slot's memory is page-aligned, and Metal reads it in place
 * (`makeBuffer(bytesNoCopy:)`), so shading needs no upload and shows exactly the CPU's state. While
 * the CPU is the authority, stepping on the GPU as well could not run the simulation faster (see
 * GOTCHAS), so only the shading moves.
 *
 * The kernel is the core's `WGSL_SHADE`, translated to Metal by `scripts/gen-msl.mjs`
 * (`WET_SHADE_MSL`) and compiled here at run time with precise maths. Its pixels stay within about
 * 1/255 of the CPU's `shadeTile` (compilers differ in `exp` / `pow`), which is what a display
 * needs. Nothing it shades is ever saved.
 */

/// Whether the Metal engine can run here, and if not, why (`WetGpuSupport` in TS).
public struct WetGpuSupport: Equatable, Sendable {
    public var supported: Bool
    /// Why not (no Metal device, the shader did not compile), or nil.
    public var reason: String?
    /// The GPU's name, when known.
    public var adapter: String?
    /// Most wet tiles (256 px, all layers) the engine can shade.
    public var maxSlots: Int
}

/// One tile to shade: the slot holding it, its size on the canvas and the base pixels under it.
struct WetShadeJob {
    let slot: WetSlot
    /// Pixels of the tile on the canvas (256 except at the right and bottom edges).
    let width: Int
    let height: Int
    /// RGBA8 256 × 256, or nil for transparent.
    let src: [UInt8]?
}

/// `0xffffffff`: no base tile (`GPU_NONE`).
private let GPU_NONE: UInt32 = 0xffff_ffff
/// Words per job record (`GPU_JOB_WORDS`).
private let JOB_WORDS = 16
private let TILE_BYTES = TILE * TILE * 4

/// The process's engine (made on first use; compiling the shader costs a little, so editors share it).
private let sharedEngine = Locked<(engine: WetMetalEngine?, support: WetGpuSupport)?>(nil)

extension WetMetalEngine {
    /// The engine every editor in this process shares (made, or found unavailable, once).
    public static func shared() -> (engine: WetMetalEngine?, support: WetGpuSupport) {
        sharedEngine.with { v in
            if v == nil { v = create() }
            return v!
        }
    }
}

#if canImport(Metal)

/// The engine on a Metal device. Make one with `WetMetalEngine.create()`, or use `shared()`. Calls are serialised.
public final class WetMetalEngine: @unchecked Sendable {
    private let lock = NSLock()
    private let device: MTLDevice
    private let queue: MTLCommandQueue
    private let pipeline: MTLComputePipelineState
    /// The GPU, when known.
    public let adapter: String?
    /// Most tiles the engine can shade (every slot the world can have).
    public let maxSlots: Int
    /// Set once a command buffer failed; the engine does nothing after that.
    public private(set) var lostReason: String?
    /// Tiles shaded so far (for stats).
    public private(set) var tilesShaded = 0
    private var srcTiles: MTLBuffer?
    private var outTiles: MTLBuffer?
    private var tileCap = 0

    private init(device: MTLDevice, queue: MTLCommandQueue, pipeline: MTLComputePipelineState) {
        self.device = device
        self.queue = queue
        self.pipeline = pipeline
        adapter = device.name
        maxSlots = MAX_WET_SLOTS
    }

    /// Starts the engine on the system's default GPU, or says why it cannot run.
    public static func create() -> (engine: WetMetalEngine?, support: WetGpuSupport) {
        func no(_ reason: String, _ adapter: String? = nil) -> (engine: WetMetalEngine?, support: WetGpuSupport) {
            (nil, WetGpuSupport(supported: false, reason: reason, adapter: adapter, maxSlots: 0))
        }
        guard let device = MTLCreateSystemDefaultDevice() else { return no("This device has no Metal GPU; wet paint runs on the CPU.") }
        let name = device.name
        if !device.hasUnifiedMemory { return no("The wet-media shading needs a GPU that shares memory with the CPU; wet paint runs on the CPU.", name) }
        if device.maxBufferLength < WET_SLOT_ALLOCATION { return no("The GPU's buffers cannot hold one wet tile; wet paint runs on the CPU.", name) }
        guard let queue = device.makeCommandQueue() else { return no("The Metal device gave no command queue; wet paint runs on the CPU.", name) }
        do {
            let options = MTLCompileOptions()
            if #available(macOS 15.0, iOS 18.0, *) {
                options.mathMode = .safe
            } else {
                options.fastMathEnabled = false
            }
            let library = try device.makeLibrary(source: WET_SHADE_MSL, options: options)
            guard let fn = library.makeFunction(name: WET_SHADE_ENTRY) else { return no("The wet-media shader has no \(WET_SHADE_ENTRY) function; wet paint runs on the CPU.", name) }
            let pipeline = try device.makeComputePipelineState(function: fn)
            if pipeline.maxTotalThreadsPerThreadgroup < 256 { return no("The GPU runs fewer than 256 threads per group; wet paint runs on the CPU.", name) }
            return (WetMetalEngine(device: device, queue: queue, pipeline: pipeline), WetGpuSupport(supported: true, reason: nil, adapter: name, maxSlots: MAX_WET_SLOTS))
        } catch {
            return no("The wet-media shader did not compile on this GPU (\(error.localizedDescription)); wet paint runs on the CPU.", name)
        }
    }

    /// Bytes of GPU-only memory in use (the slots are shared with the CPU and not counted).
    public func memoryBytes() -> Int { (srcTiles?.length ?? 0) + (outTiles?.length ?? 0) }

    /// The Metal buffer over a slot's memory (made once per slot and device).
    private func buffer(_ slot: WetSlot) throws -> MTLBuffer {
        if let b = slot.gpuBuffer as? MTLBuffer, b.device === device { return b }
        guard let b = device.makeBuffer(bytesNoCopy: UnsafeMutableRawPointer(slot.f), length: WET_SLOT_ALLOCATION, options: .storageModeShared, deallocator: nil) else {
            throw WetWorldError("Metal could not use a wet tile's memory.")
        }
        slot.gpuBuffer = b
        return b
    }

    private func ensureTiles(_ n: Int) throws {
        if n <= tileCap, srcTiles != nil, outTiles != nil { return }
        let cap = Swift.max(n, tileCap * 2, 4)
        guard let src = device.makeBuffer(length: cap * TILE_BYTES, options: .storageModeShared),
              let out = device.makeBuffer(length: cap * TILE_BYTES, options: .storageModeShared) else {
            throw WetWorldError("The GPU has no room for \(cap) shaded tiles.")
        }
        srcTiles = src
        outTiles = out
        tileCap = cap
    }

    /**
     * Shades `jobs` (state set `parity`) over their base tiles on `paper` (sRGB bytes): `dried`
     * false is the display (wet paper a little darker), true shows the paint as it would dry.
     * Returns one RGBA8 tile per job. The caller must not change the slots until this returns.
     */
    func shade(_ jobs: [WetShadeJob], parity: Int, paper: [Int], dried: Bool = false) throws -> [[UInt8]] {
        lock.lock()
        defer { lock.unlock() }
        if let lostReason { throw WetWorldError("The GPU is gone (\(lostReason)).") }
        if jobs.isEmpty { return [] }
        try ensureTiles(jobs.count)
        let src = srcTiles!, out = outTiles!
        var srcIndex: [Int] = []
        var srcCount = 0
        for job in jobs {
            guard let data = job.src else { srcIndex.append(-1); continue }
            if data.count != TILE_BYTES { throw WetWorldError("A base tile has \(data.count) bytes, not \(TILE_BYTES).") }
            data.withUnsafeBytes { (src.contents() + srcCount * TILE_BYTES).copyMemory(from: $0.baseAddress!, byteCount: TILE_BYTES) }
            srcIndex.append(srcCount)
            srcCount += 1
        }
        let paperWord = UInt32(paper[0] & 255) | UInt32(paper[1] & 255) << 8 | UInt32(paper[2] & 255) << 16
        var uni: [UInt32] = [UInt32(parity & 1), dried ? 1 : 0, paperWord, 0]
        guard let cmd = queue.makeCommandBuffer(), let enc = cmd.makeComputeCommandEncoder() else { throw WetWorldError("Metal gave no command buffer.") }
        enc.setComputePipelineState(pipeline)
        enc.setBytes(&uni, length: 16, index: 4)
        let grid = MTLSize(width: 16, height: 16, depth: 1)
        let group = MTLSize(width: 16, height: 16, depth: 1)
        for (i, job) in jobs.enumerated() {
            let slot = try buffer(job.slot)
            // Each dispatch sees its own tile at index 0: the slot at its start, its job, base and output tiles by offset.
            var record = [UInt32](repeating: 0, count: JOB_WORDS)
            for k in 0..<8 { record[2 + k] = GPU_NONE }
            record[10] = UInt32(job.width)
            record[11] = UInt32(job.height)
            record[12] = srcIndex[i] >= 0 ? 0 : GPU_NONE
            var sizes: [UInt32] = [UInt32(WET_SLOT_ALLOCATION), UInt32(TILE_BYTES), UInt32(JOB_WORDS * 4), UInt32(TILE_BYTES)]
            enc.setBuffer(slot, offset: 0, index: 0)
            enc.setBuffer(src, offset: Swift.max(0, srcIndex[i]) * TILE_BYTES, index: 1)
            enc.setBytes(&record, length: JOB_WORDS * 4, index: 2)
            enc.setBuffer(out, offset: i * TILE_BYTES, index: 3)
            enc.setBytes(&sizes, length: 16, index: WET_SHADE_SIZES_INDEX)
            enc.dispatchThreadgroups(grid, threadsPerThreadgroup: group)
        }
        enc.endEncoding()
        cmd.commit()
        cmd.waitUntilCompleted()
        if let error = cmd.error {
            lostReason = error.localizedDescription
            throw WetWorldError("The GPU failed to shade wet paint (\(error.localizedDescription)).")
        }
        tilesShaded += jobs.count
        let base = out.contents()
        return (0..<jobs.count).map { i in [UInt8](UnsafeRawBufferPointer(start: base + i * TILE_BYTES, count: TILE_BYTES)) }
    }
}

#else

/// No Metal on this platform: `create()` always says why.
public final class WetMetalEngine: @unchecked Sendable {
    public let adapter: String? = nil
    public let maxSlots = 0
    public let lostReason: String? = nil
    public static func create() -> (engine: WetMetalEngine?, support: WetGpuSupport) {
        (nil, WetGpuSupport(supported: false, reason: "This platform has no Metal; wet paint runs on the CPU.", adapter: nil, maxSlots: 0))
    }
    func shade(_ jobs: [WetShadeJob], parity: Int, paper: [Int], dried: Bool = false) throws -> [[UInt8]] {
        throw WetWorldError("This platform has no Metal.")
    }
}

#endif
