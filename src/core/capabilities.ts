/** Detects rendering capabilities once, so the renderer can choose a path explicitly. */
export type RenderBackend = 'webgl2' | 'webgl1' | 'none';

export interface Capabilities {
  readonly backend: RenderBackend;
  readonly webgpu: boolean;
  readonly webxr: boolean;
  readonly maxTextureSize: number;
}

export async function detectCapabilities(doc: Document = document, nav: Navigator = navigator): Promise<Capabilities> {
  const canvas = doc.createElement('canvas');
  const gl2 = canvas.getContext('webgl2');
  const gl1 = gl2 ? null : canvas.getContext('webgl');
  const gl = gl2 ?? gl1;
  const backend: RenderBackend = gl2 ? 'webgl2' : gl1 ? 'webgl1' : 'none';
  const maxTextureSize = gl ? Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) : 0;
  const webxr = 'xr' in nav && nav.xr !== undefined;
  const webgpu = 'gpu' in nav && (nav as Navigator & { gpu?: unknown }).gpu !== undefined;
  return { backend, webgpu, webxr, maxTextureSize };
}
