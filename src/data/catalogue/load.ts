/** Browser-side dataset loading. Reads LOCAL files only; no astronomy service is contacted at runtime. */
export async function loadJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const gz = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b; // a server may already have decoded it
  const text = gz
    ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    : new TextDecoder().decode(bytes);
  return JSON.parse(text) as T;
}
