// Portions ported from gridcraft/crates/numfmt/src/builtin.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import Foundation

/// Built-in number formats (ECMA-376 §18.8.30, en-US).
public let BUILTIN_NUMBER_FORMATS: [(id: Int, code: String)] = [
    (0, "General"),
    (1, "0"),
    (2, "0.00"),
    (3, "#,##0"),
    (4, "#,##0.00"),
    (5, "\"$\"#,##0_);\\(\"$\"#,##0\\)"),
    (6, "\"$\"#,##0_);[Red]\\(\"$\"#,##0\\)"),
    (7, "\"$\"#,##0.00_);\\(\"$\"#,##0.00\\)"),
    (8, "\"$\"#,##0.00_);[Red]\\(\"$\"#,##0.00\\)"),
    (9, "0%"),
    (10, "0.00%"),
    (11, "0.00E+00"),
    (12, "# ?/?"),
    (13, "# ??/??"),
    (14, "m/d/yyyy"),
    (15, "d-mmm-yy"),
    (16, "d-mmm"),
    (17, "mmm-yy"),
    (18, "h:mm AM/PM"),
    (19, "h:mm:ss AM/PM"),
    (20, "h:mm"),
    (21, "h:mm:ss"),
    (22, "m/d/yyyy h:mm"),
    (37, "#,##0 ;(#,##0)"),
    (38, "#,##0 ;[Red](#,##0)"),
    (39, "#,##0.00;(#,##0.00)"),
    (40, "#,##0.00;[Red](#,##0.00)"),
    (41, "_(* #,##0_);_(* \\(#,##0\\);_(* \"-\"_);_(@_)"),
    (42, "_(\"$\"* #,##0_);_(\"$\"* \\(#,##0\\);_(\"$\"* \"-\"_);_(@_)"),
    (43, "_(* #,##0.00_);_(* \\(#,##0.00\\);_(* \"-\"??_);_(@_)"),
    (44, "_(\"$\"* #,##0.00_);_(\"$\"* \\(#,##0.00\\);_(\"$\"* \"-\"??_);_(@_)"),
    (45, "mm:ss"),
    (46, "[h]:mm:ss"),
    (47, "mmss.0"),
    (48, "##0.0E+0"),
    (49, "@")
]

/// Built-in format code for an id (0–49, en-US), e.g. 14 → `m/d/yyyy`.
/// Locale-specific ids (23–36) and unknown ids return nil.
public func builtinNumberFormat(_ id: Int) -> String? {
    BUILTIN_NUMBER_FORMATS.first(where: { $0.id == id })?.code
}

/// Id of a built-in format code. Matching ignores case and backslash escapes.
public func builtinNumberFormatId(_ code: String) -> Int? {
    if let exact = BUILTIN_NUMBER_FORMATS.first(where: { $0.code == code }) {
        return exact.id
    }
    func norm(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "").lowercased()
    }
    let n = norm(code)
    return BUILTIN_NUMBER_FORMATS.first(where: { norm($0.code) == n })?.id
}
