import XCTest
@testable import PixerateCore

/// `parseFloat` and `Number` of strings, as V8 reads them (values checked in Node).
final class JSNumberParsingTests: XCTestCase {
    func testParseFloat() {
        let cases: [(String, Double)] = [
            ("  3.5px", 3.5), (".5", 0.5), ("5.", 5), ("5.e2", 500), ("-12e-1x", -1.2), ("1e", 1), ("1e+", 1), ("+7", 7),
            ("\u{FEFF}\u{A0}42", 42), ("-Infinityx", -.infinity), ("Infinity", .infinity), ("50%", 50), ("0x10", 0), ("1.2.3", 1.2),
        ]
        for (s, v) in cases { XCTAssertEqual(s.jsParseFloat, v, s) }
        for s in ["", "e5", ".", "-", "px", "+-1", "\u{85}1"] { XCTAssertTrue(s.jsParseFloat.isNaN, s) }
    }

    func testNumber() {
        let cases: [(String, Double)] = [
            ("", 0), ("  ", 0), (" 12 ", 12), ("0x1F", 31), ("0b101", 5), ("0o17", 15), ("5.", 5), ("+.5e1", 5), ("-3", -3), ("1e3", 1000), ("-Infinity", -.infinity),
        ]
        for (s, v) in cases { XCTAssertEqual(s.jsToNumber, v, s) }
        for s in ["1,2", ".", "-0x10", "0x", "1e", "12px", "Infinityx", "0xg"] { XCTAssertTrue(s.jsToNumber.isNaN, s) }
    }
}
