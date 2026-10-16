import { describe, expect, it } from "vitest";
import { sniffImageType } from "../../app/lib/image-type";

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe("sniffImageType", () => {
  it("recognises JPEG, PNG, WebP and HEIC by their signatures", () => {
    expect(sniffImageType(bytes([0xff, 0xd8, 0xff, 0xdb]))).toBe("image/jpeg");
    expect(sniffImageType(bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffImageType(bytes("RIFF", [1, 2, 3, 4], "WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(bytes([0, 0, 0, 0x18], "ftypheic", [0, 0, 0, 0]))).toBe("image/heic");
    expect(sniffImageType(bytes([0, 0, 0, 0x18], "ftypmif1", [0, 0, 0, 0]).buffer)).toBe("image/heic");
  });

  it("refuses anything else, whatever it claims to be", () => {
    expect(sniffImageType(bytes("GIF89a"))).toBeNull();
    expect(sniffImageType(bytes("%PDF-1.7"))).toBeNull();
    expect(sniffImageType(bytes([0, 0, 0, 0x18], "ftypisom", [0, 0, 0, 0]))).toBeNull(); // MP4
    expect(sniffImageType(bytes("RIFF", [1, 2, 3, 4], "WAVE"))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});
