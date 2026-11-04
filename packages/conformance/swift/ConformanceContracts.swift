import Foundation

/// The files of `@pixerate/conformance`, bundled with the Swift package: each domain's contracts
/// (`domains/<domain>/*.json`), its recorded scenarios (`domains/<domain>/fixtures/`) and the
/// schemas (`schema/`). The TypeScript core writes them; this target only makes them readable.
public enum ConformanceContracts {
    /// The bundled `@pixerate/conformance` folder.
    public static var root: URL {
        Bundle.module.resourceURL!
    }

    /// A contract file by its path inside the package, such as `domains/paint/tools.json`.
    public static func url(_ path: String) -> URL {
        root.appendingPathComponent(path)
    }

    /// The bytes of a contract file, such as `domains/paint/tools.json`.
    public static func data(_ path: String) throws -> Data {
        try Data(contentsOf: url(path))
    }
}
