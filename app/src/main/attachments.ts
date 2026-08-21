import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";

import { nativeImage, protocol } from "electron";

import type { ImportedAttachment } from "@shared/ipc.ts";

export const ATTACHMENT_SCHEME = "osfile";

export class AttachmentError extends Error {}

/**
 * Normalises every user-supplied image to PNG in a private directory, so the
 * prompt path only ever hands the runtime a local path plus a mime type.
 */
export class AttachmentStore {
  constructor(private readonly directory: string) {}

  async importFiles(paths: string[]): Promise<ImportedAttachment[]> {
    const imported: ImportedAttachment[] = [];
    try {
      for (const path of paths) {
        imported.push(await this.importBytes(await readFile(path)));
      }
      return imported;
    } catch (error) {
      await this.discard(imported);
      throw error;
    }
  }

  async importBuffers(buffers: Uint8Array[]): Promise<ImportedAttachment[]> {
    const imported: ImportedAttachment[] = [];
    try {
      for (const buffer of buffers) {
        imported.push(await this.importBytes(Buffer.from(buffer)));
      }
      return imported;
    } catch (error) {
      await this.discard(imported);
      throw error;
    }
  }

  async remove(path: string): Promise<void> {
    if (!this.contains(path)) return;
    try {
      await unlink(path);
    } catch {
      // A missing file is the desired end state.
    }
  }

  /** True when `path` is inside the store, guarding the custom-scheme handler. */
  contains(path: string): boolean {
    const root = resolve(this.directory) + "/";
    return resolve(normalize(path)).startsWith(root);
  }

  private async importBytes(bytes: Buffer): Promise<ImportedAttachment> {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new AttachmentError("That file isn't a supported image.");
    const png = image.toPNG();
    if (png.length === 0) throw new AttachmentError("Couldn't prepare that image.");
    await mkdir(this.directory, { recursive: true });
    const id = randomUUID();
    const path = join(this.directory, `${id}.png`);
    await writeFile(path, png);
    return { id, path, mimeType: "image/png", url: attachmentUrl(path) };
  }

  private async discard(imported: ImportedAttachment[]): Promise<void> {
    await Promise.all(imported.map((item) => this.remove(item.path)));
  }
}

export function attachmentUrl(path: string): string {
  return `${ATTACHMENT_SCHEME}://local/${encodeURIComponent(path)}`;
}

export function registerAttachmentSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ATTACHMENT_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}

/**
 * Serves attachment bytes to the renderers without turning on `file://` access.
 * Only paths inside the store are readable.
 */
export function handleAttachmentScheme(store: AttachmentStore): void {
  protocol.handle(ATTACHMENT_SCHEME, async (request) => {
    const path = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ""));
    if (!store.contains(path)) return new Response("Forbidden", { status: 403 });
    try {
      const bytes = await readFile(path);
      return new Response(new Uint8Array(bytes), {
        headers: { "content-type": "image/png" },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}
