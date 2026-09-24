export type Picked = { path: string; file: File };


/** Zips cannot take the chunked route (the server has to unpack one to know what is inside), so a
 *  large zip can only be called out up front rather than sent off to wait for a 413 — an error that
 *  would then need explaining all over again. */
/** Recursively read a dropped directory entry into files carrying their relative paths. */
function readEntry(entry: FileSystemEntry, out: Picked[]): Promise<void> {
  return new Promise((resolve) => {
    if (entry.isFile) {
      (entry as FileSystemFileEntry).file((file) => {
        out.push({ path: entry.fullPath.replace(/^\//, ""), file });
        resolve();
      }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const entries: FileSystemEntry[] = [];
      const readBatch = () => {
        reader.readEntries(async (batch) => {
          if (batch.length === 0) {
            await Promise.all(entries.map((e) => readEntry(e, out)));
            resolve();
          } else {
            entries.push(...batch);
            readBatch();
          }
        }, () => resolve());
      };
      readBatch();
    } else {
      resolve();
    }
  });
}

export async function collectFromDrop(dt: DataTransfer): Promise<Picked[]> {
  const items = Array.from(dt.items).filter((i) => i.kind === "file");
  const entries = items.map((i) => i.webkitGetAsEntry?.() ?? null);
  if (entries.some(Boolean)) {
    const out: Picked[] = [];
    await Promise.all(entries.map((e) => (e ? readEntry(e, out) : Promise.resolve())));
    if (out.length) return out;
  }
  // Fallback: plain file list with no directory structure.
  return Array.from(dt.files).map((file) => ({ path: file.name, file }));
}

