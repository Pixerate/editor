import Foundation
import PixerateCore

// JSON Schema fragments shared by the chart commands and the chart agent tools.

public let CHART_SCHEMA_VALUE: JSONValue = .object(JSONObject([
    ("type", .array([.string("number"), .string("string"), .string("null")])),
    ("description", .string("A number, numeric text (\"1,200\", \"12%\", \"$40\", \"(3)\") or null for a gap."))
]))

public let CHART_SCHEMA_SERIES_REF: JSONValue = .object(JSONObject([
    ("type", .string("string")),
    ("description", .string("Series id (from get_chart) or exact series name."))
]))

public let CHART_SCHEMA_CATEGORY_REF: JSONValue = .object(JSONObject([
    ("type", .array([.string("string"), .string("integer")])),
    ("description", .string("Category index (0-based) or exact category label."))
]))

public let CHART_SCHEMA_WIDTH: JSONValue = .object(JSONObject([
    ("type", .string("number")),
    ("minimum", .number(50)),
    ("maximum", .number(4096)),
    ("description", .string("Width in pixels (default 640)."))
]))

public let CHART_SCHEMA_HEIGHT: JSONValue = .object(JSONObject([
    ("type", .string("number")),
    ("minimum", .number(50)),
    ("maximum", .number(4096)),
    ("description", .string("Height in pixels (default 400)."))
]))

public let CHART_SCHEMA_FORMAT: JSONValue = .object(JSONObject([
    ("type", .string("object")),
    ("description", .string("How numbers are written on this axis or series.")),
    ("properties", .object(JSONObject([
        ("style", .object(JSONObject([
            ("type", .string("string")),
            ("enum", .array(CHART_NUMBER_STYLES.map { .string($0.rawValue) })),
            ("description", .string("number (default), percent (0.25 → 25%), currency or compact (1.2K)."))
        ]))),
        ("decimals", .object(JSONObject([
            ("type", .string("integer")),
            ("minimum", .number(0)),
            ("maximum", .number(10)),
            ("description", .string("Fixed decimals (default: what the ticks need)."))
        ]))),
        ("currency", .object(JSONObject([
            ("type", .string("string")),
            ("description", .string("ISO currency code for style \"currency\", e.g. \"EUR\" (default USD)."))
        ]))),
        ("prefix", .object(JSONObject([
            ("type", .string("string")),
            ("description", .string("Text before every number."))
        ]))),
        ("suffix", .object(JSONObject([
            ("type", .string("string")),
            ("description", .string("Text after every number."))
        ]))),
        ("code", .object(JSONObject([
            ("type", .string("string")),
            ("description", .string("Spreadsheet format code such as \"#,##0.0,,\\\"M\\\"\" or \"0.0%\"; wins over the other fields."))
        ])))
    ]))),
    ("additionalProperties", .bool(false))
]))
