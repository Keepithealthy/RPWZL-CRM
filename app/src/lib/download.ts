/** Hands a text or binary payload to the user as a file download. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadText(text: string, fileName: string, mime = 'text/csv;charset=utf-8'): void {
  downloadBlob(new Blob([text], { type: mime }), fileName);
}

export async function gzipText(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

/** Reads a plain or gzip-compressed text file (detected by the gzip magic bytes). */
export async function readMaybeGzip(file: Blob): Promise<string> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  return file.text();
}
