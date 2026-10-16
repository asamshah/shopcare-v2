/**
 * File storage behind a small interface, so the backend can change later
 * (Netlify Blobs today, S3 or R2 if needed) without touching callers.
 *
 * Drivers (STORAGE_DRIVER):
 *   netlify  Netlify Blobs. The default when running on Netlify; site ID and
 *            token are injected automatically inside Netlify Functions.
 *   fs       Local disk under STORAGE_FS_ROOT (default ./.storage). The default
 *            for local development (`shopify app dev`).
 *   memory   In-process Map. The default under Vitest.
 *
 * Netlify Blobs has no signed URLs, so `signedUrl()` returns a URL on this app
 * (`/files/<key>?exp=…&sig=…`) that the `files.$` route checks and streams. An
 * S3 driver could return a real presigned URL from the same method instead.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStore } from "@netlify/blobs";
import { derivedSecret, hmacHex, safeEqualHex } from "./signing.server";

export interface StoredFile {
  body: ArrayBuffer;
  contentType: string;
  metadata: Record<string, string>;
}

export interface PutOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface FileStorage {
  put(
    key: string,
    body: ArrayBuffer | Uint8Array | string,
    options?: PutOptions,
  ): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  delete(key: string): Promise<void>;
}

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

function toArrayBuffer(body: ArrayBuffer | Uint8Array | string): ArrayBuffer {
  if (typeof body === "string")
    return new TextEncoder().encode(body).buffer as ArrayBuffer;
  if (body instanceof Uint8Array) {
    return body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer;
  }
  return body;
}

/** Keys are path-like ("shops/<shop>/tickets/12/photo.png"); no "..", no leading slash. */
export function assertValidKey(key: string) {
  if (
    !key ||
    key.startsWith("/") ||
    key.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
  }
}

export class MemoryStorage implements FileStorage {
  private files = new Map<string, StoredFile>();

  async put(
    key: string,
    body: ArrayBuffer | Uint8Array | string,
    options: PutOptions = {},
  ) {
    assertValidKey(key);
    this.files.set(key, {
      body: toArrayBuffer(body),
      contentType: options.contentType ?? DEFAULT_CONTENT_TYPE,
      metadata: options.metadata ?? {},
    });
  }

  async get(key: string) {
    assertValidKey(key);
    return this.files.get(key) ?? null;
  }

  async delete(key: string) {
    assertValidKey(key);
    this.files.delete(key);
  }
}

export class FsStorage implements FileStorage {
  constructor(private root: string) {}

  private paths(key: string) {
    assertValidKey(key);
    const file = path.resolve(this.root, key);
    if (!file.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return { file, meta: `${file}.meta.json` };
  }

  async put(
    key: string,
    body: ArrayBuffer | Uint8Array | string,
    options: PutOptions = {},
  ) {
    const { file, meta } = this.paths(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(toArrayBuffer(body)));
    await writeFile(
      meta,
      JSON.stringify({
        contentType: options.contentType ?? DEFAULT_CONTENT_TYPE,
        metadata: options.metadata ?? {},
      }),
    );
  }

  async get(key: string) {
    const { file, meta } = this.paths(key);
    try {
      const [data, info] = await Promise.all([
        readFile(file),
        readFile(meta, "utf8"),
      ]);
      const { contentType, metadata } = JSON.parse(info);
      return {
        body: toArrayBuffer(new Uint8Array(data)),
        contentType,
        metadata,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string) {
    const { file, meta } = this.paths(key);
    await Promise.all([rm(file, { force: true }), rm(meta, { force: true })]);
  }
}

export class NetlifyBlobStorage implements FileStorage {
  constructor(private storeName: string) {}

  // Strong consistency: a ticket photo must be readable straight after upload.
  private store() {
    return getStore({ name: this.storeName, consistency: "strong" });
  }

  async put(
    key: string,
    body: ArrayBuffer | Uint8Array | string,
    options: PutOptions = {},
  ) {
    assertValidKey(key);
    await this.store().set(key, toArrayBuffer(body), {
      metadata: {
        contentType: options.contentType ?? DEFAULT_CONTENT_TYPE,
        ...options.metadata,
      },
    });
  }

  async get(key: string) {
    assertValidKey(key);
    const entry = await this.store().getWithMetadata(key, {
      type: "arrayBuffer",
    });
    if (!entry) return null;
    const { contentType, ...metadata } = entry.metadata as Record<
      string,
      string
    >;
    return {
      body: entry.data,
      contentType: contentType ?? DEFAULT_CONTENT_TYPE,
      metadata,
    };
  }

  async delete(key: string) {
    assertValidKey(key);
    await this.store().delete(key);
  }
}

function defaultDriver(): string {
  if (process.env.STORAGE_DRIVER) return process.env.STORAGE_DRIVER;
  if (process.env.VITEST) return "memory";
  if (
    "Netlify" in globalThis ||
    process.env.NETLIFY === "true" ||
    process.env.NETLIFY_BLOBS_CONTEXT
  ) {
    return "netlify";
  }
  return "fs";
}

export function createStorage(driver = defaultDriver()): FileStorage {
  switch (driver) {
    case "netlify":
      return new NetlifyBlobStorage(
        process.env.STORAGE_BLOB_STORE ?? "shopcare-files",
      );
    case "fs":
      return new FsStorage(
        process.env.STORAGE_FS_ROOT ?? path.resolve(".storage"),
      );
    case "memory":
      return new MemoryStorage();
    default:
      throw new Error(`Unknown STORAGE_DRIVER: ${driver}`);
  }
}

let storage: FileStorage | undefined;

/** The app-wide storage instance. */
export function getStorage(): FileStorage {
  storage ??= createStorage();
  return storage;
}

// ---------------------------------------------------------------------------
// Signed URLs (served by app/routes/files.$.tsx)

const FILES_PATH = "/files/";

function fileSignature(key: string, expiresAt: number) {
  return hmacHex(derivedSecret("shopcare:file-urls"), `${key}\n${expiresAt}`);
}

/**
 * A time-limited URL for a stored file. `baseUrl` defaults to SHOPIFY_APP_URL;
 * pass "" for a path-only URL.
 */
export function signedUrl(
  key: string,
  {
    expiresInSeconds = 15 * 60,
    baseUrl = process.env.SHOPIFY_APP_URL ?? "",
    now = Date.now(),
  } = {},
): string {
  assertValidKey(key);
  const exp = Math.floor(now / 1000) + expiresInSeconds;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${baseUrl}${FILES_PATH}${encodedKey}?exp=${exp}&sig=${fileSignature(key, exp)}`;
}

/** Returns the storage key if the URL's signature is valid and not expired, otherwise null. */
export function verifySignedUrl(url: URL, now = Date.now()): string | null {
  if (!url.pathname.startsWith(FILES_PATH)) return null;
  const key = url.pathname
    .slice(FILES_PATH.length)
    .split("/")
    .map(decodeURIComponent)
    .join("/");
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  if (!Number.isInteger(exp) || exp * 1000 < now) return null;
  try {
    assertValidKey(key);
  } catch {
    return null;
  }
  return safeEqualHex(sig, fileSignature(key, exp)) ? key : null;
}
