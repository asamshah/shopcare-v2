import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertValidKey,
  FsStorage,
  MemoryStorage,
  signedUrl,
  verifySignedUrl,
  type FileStorage,
} from "../../app/lib/storage.server";

const tmpRoots: string[] = [];
afterAll(async () => {
  await Promise.all(
    tmpRoots.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// Every driver must pass the same contract.
const drivers: [string, () => Promise<FileStorage>][] = [
  ["memory", async () => new MemoryStorage()],
  [
    "fs",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "shopcare-storage-"));
      tmpRoots.push(dir);
      return new FsStorage(dir);
    },
  ],
];

describe.each(drivers)("%s storage", (_name, make) => {
  it("stores, reads and deletes a file with its content type and metadata", async () => {
    const storage = await make();
    const bytes = new Uint8Array([137, 80, 78, 71]);
    await storage.put("shops/a/tickets/1/photo.png", bytes, {
      contentType: "image/png",
      metadata: { ticket: "1" },
    });

    const file = await storage.get("shops/a/tickets/1/photo.png");
    expect(new Uint8Array(file!.body)).toEqual(bytes);
    expect(file!.contentType).toBe("image/png");
    expect(file!.metadata).toEqual({ ticket: "1" });

    await storage.delete("shops/a/tickets/1/photo.png");
    expect(await storage.get("shops/a/tickets/1/photo.png")).toBeNull();
  });

  it("returns null for a missing key and deletes missing keys quietly", async () => {
    const storage = await make();
    expect(await storage.get("nope.txt")).toBeNull();
    await expect(storage.delete("nope.txt")).resolves.toBeUndefined();
  });
});

describe("storage keys", () => {
  it("rejects path traversal and absolute keys", () => {
    for (const bad of ["", "/etc/passwd", "../secrets", "a/../../b", "a//b"]) {
      expect(() => assertValidKey(bad)).toThrow();
    }
    expect(() => assertValidKey("shops/a/file name.png")).not.toThrow();
  });
});

describe("signed URLs", () => {
  const now = Date.UTC(2026, 9, 16, 12);

  it("verifies its own URL and returns the key", () => {
    const url = new URL(signedUrl("shops/a/file name.png", { now }));
    expect(url.origin).toBe("https://shopcare.test");
    expect(verifySignedUrl(url, now)).toBe("shops/a/file name.png");
  });

  it("rejects expired, tampered or retargeted URLs", () => {
    const url = new URL(
      signedUrl("shops/a/x.png", { expiresInSeconds: 60, now }),
    );
    expect(verifySignedUrl(url, now + 61_000)).toBeNull();

    const tampered = new URL(url);
    tampered.searchParams.set(
      "exp",
      String(Number(url.searchParams.get("exp")) + 3600),
    );
    expect(verifySignedUrl(tampered, now)).toBeNull();

    const otherFile = new URL(url);
    otherFile.pathname = "/files/shops/b/x.png";
    expect(verifySignedUrl(otherFile, now)).toBeNull();
  });
});
