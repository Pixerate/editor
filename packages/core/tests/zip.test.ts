import { describe, it, expect } from "vitest";
import { readZip, ZipError, isUnsafeZipPath, zipCrc32 } from "../src";
import { buildZip } from "./helpers/zip-writer";

const expectZipError = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (e) => e,
  );
  expect(error).toBeInstanceOf(ZipError);
  expect(error.code).toBe(code);
  return error as ZipError;
};

describe("ZIP reader: parsing", () => {
  it("reads stored and deflated entries, directories and UTF-8 names", async () => {
    const big = "lorem ipsum ".repeat(5000);
    const bytes = await buildZip([
      { name: "docs/", data: "", method: 0 },
      { name: "docs/a.txt", data: "stored text", method: 0 },
      { name: "docs/b.md", data: big, method: 8 },
      { name: "naïve ✓.txt", data: "unicode" },
    ]);
    const zip = await readZip(bytes);
    expect(zip.entries.map((e) => e.name)).toEqual(["docs/", "docs/a.txt", "docs/b.md", "naïve ✓.txt"]);
    expect(zip.get("docs/")?.isDirectory).toBe(true);
    expect(await zip.readText("docs/a.txt")).toBe("stored text");
    const b = zip.get("docs/b.md")!;
    expect(b.method).toBe(8);
    expect(b.compressedSize).toBeLessThan(b.size);
    expect(await zip.readText(b)).toBe(big);
    expect(await zip.readText("/naïve ✓.txt")).toBe("unicode");
    expect(await zip.read("docs/")).toHaveLength(0);
    expect(zip.extractedSize).toBe(11 + big.length + 7);
  });

  it("accepts ArrayBuffers and offset typed-array views", async () => {
    const bytes = await buildZip([{ name: "a.txt", data: "x" }]);
    expect(await (await readZip(bytes.slice().buffer)).readText("a.txt")).toBe("x");
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 5);
    expect(await (await readZip(padded.subarray(5, 5 + bytes.length))).readText("a.txt")).toBe("x");
  });

  it("finds the end record behind an archive comment", async () => {
    const zip = await readZip(await buildZip([{ name: "a.txt", data: "x" }], { comment: "PK\u0005\u0006 fake" }));
    expect(await zip.readText("a.txt")).toBe("x");
  });

  it("reads ZIP64 end records and extended-information extra fields", async () => {
    const zip = await readZip(
      await buildZip(
        [
          { name: "a.txt", data: "first", method: 0 },
          { name: "b.txt", data: "second ".repeat(100) },
        ],
        { zip64: true },
      ),
    );
    expect(zip.entries).toHaveLength(2);
    expect(zip.get("b.txt")!.size).toBe(700);
    expect(await zip.readText("a.txt")).toBe("first");
    expect(await zip.readText("b.txt")).toBe("second ".repeat(100));
  });

  it("decodes names without the UTF-8 flag as CP437", async () => {
    const zip = await readZip(await buildZip([{ name: "", rawName: Uint8Array.from([0x63, 0x61, 0x66, 0x82]), data: "x" }]));
    expect(zip.entries[0].name).toBe("café");
  });

  it("normalizes backslashes and computes CRC-32", async () => {
    const zip = await readZip(await buildZip([{ name: "dir\\file.txt", data: "x" }]));
    expect(zip.entries[0].name).toBe("dir/file.txt");
    expect(zipCrc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("ZIP reader: malformed and malicious archives", () => {
  it("rejects non-ZIP data and truncated directories", async () => {
    await expectZipError(readZip(new TextEncoder().encode("definitely not a zip file")), "invalid_archive");
    await expectZipError(readZip(new Uint8Array(0)), "invalid_archive");
    const bytes = await buildZip([{ name: "a.txt", data: "x" }]);
    // Point the central directory past the end of the file.
    const broken = bytes.slice();
    const eocd = broken.length - 22;
    new DataView(broken.buffer).setUint32(eocd + 16, broken.length + 100, true);
    await expectZipError(readZip(broken), "invalid_archive");
  });

  it("caps the number of entries", async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: "x", method: 0 }));
    const bytes = await buildZip(entries);
    await expectZipError(readZip(bytes, { maxEntries: 4 }), "too_many_entries");
    expect((await readZip(bytes, { maxEntries: 5 })).entries).toHaveLength(5);
  });

  it("caps the total uncompressed size across reads (zip bombs)", async () => {
    const zeros = new Uint8Array(1024 * 1024); // 1 MiB of zeros deflates to ~1 KiB
    const bytes = await buildZip([
      { name: "a.bin", data: zeros },
      { name: "b.bin", data: zeros },
    ]);
    expect(bytes.length).toBeLessThan(10_000);
    const zip = await readZip(bytes, { maxTotalSize: 1.5 * 1024 * 1024 });
    expect((await zip.read("a.bin")).length).toBe(zeros.length);
    const error = await expectZipError(zip.read("b.bin"), "too_large");
    expect(error.entryName).toBe("b.bin");
  });

  it("stops inflating when the output exceeds the declared size", async () => {
    const zeros = new Uint8Array(4 * 1024 * 1024);
    const zip = await readZip(await buildZip([{ name: "bomb.bin", data: zeros, declaredSize: 100 }]));
    expect(zip.get("bomb.bin")!.size).toBe(100);
    await expectZipError(zip.read("bomb.bin"), "corrupt_entry");
    expect(zip.extractedSize).toBe(0);
  });

  it("rejects path traversal and absolute names, or skips them on request", async () => {
    for (const name of ["../evil.txt", "a/../../evil.txt", "/etc/passwd", "C:\\Windows\\x.txt", "..\\evil.txt"]) {
      const bytes = await buildZip([{ name, data: "x" }]);
      await expectZipError(readZip(bytes), "unsafe_path");
    }
    const zip = await readZip(await buildZip([{ name: "../evil.txt", data: "x" }, { name: "ok.txt", data: "y" }]), {
      unsafePaths: "skip",
    });
    expect(zip.entries.map((e) => e.name)).toEqual(["ok.txt"]);
    expect(isUnsafeZipPath("a/b..c/d.txt")).toBe(false);
    expect(isUnsafeZipPath("a/\0b")).toBe(true);
  });

  it("lists encrypted entries but refuses to read them", async () => {
    const zip = await readZip(await buildZip([{ name: "secret.txt", data: "x", flags: 0x0801 }]));
    expect(zip.entries[0].encrypted).toBe(true);
    await expectZipError(zip.read("secret.txt"), "encrypted");
  });

  it("rejects unsupported methods, CRC mismatches, corrupt streams and missing entries", async () => {
    const lzma = await readZip(await buildZip([{ name: "a.txt", data: "x", method: 14 }]));
    await expectZipError(lzma.read("a.txt"), "unsupported_feature");

    const badCrc = await readZip(await buildZip([{ name: "a.txt", data: "x", crc: 1234 }]));
    await expectZipError(badCrc.read("a.txt"), "corrupt_entry");

    const bytes = await buildZip([{ name: "a.txt", data: "hello hello hello hello" }]);
    const garbled = bytes.slice();
    for (let i = 30 + 5; i < 30 + 5 + 6; i++) garbled[i] = 0xff;
    await expectZipError((await readZip(garbled)).read("a.txt"), "corrupt_entry");

    await expectZipError(lzma.read("missing.txt"), "entry_not_found");
  });

  it("reports a clear error when DecompressionStream is unavailable", async () => {
    const zip = await readZip(await buildZip([{ name: "a.txt", data: "x" }]));
    const original = (globalThis as any).DecompressionStream;
    (globalThis as any).DecompressionStream = undefined;
    try {
      await expectZipError(zip.read("a.txt"), "unsupported_environment");
    } finally {
      (globalThis as any).DecompressionStream = original;
    }
  });
});
