import { detectCapabilities } from './core/capabilities';
import { DataRegistry, SEED_SOLAR, validateDataset } from './data';

/**
 * Bootstrap only. The universe renderer is intentionally not started here (Prompt 02).
 * This proves the module graph loads and reports what the browser can do.
 */
async function boot() {
  const status = document.getElementById('status');
  const caps = await detectCapabilities();
  const registry = new DataRegistry().register(SEED_SOLAR);
  const issues = validateDataset(SEED_SOLAR);
  const lines = [
    `Render backend: ${caps.backend}`,
    `WebGPU available: ${caps.webgpu ? 'yes' : 'no'}`,
    `WebXR present: ${caps.webxr ? 'yes' : 'no'}`,
    `Max texture size: ${caps.maxTextureSize}`,
    `Catalogue objects loaded: ${registry.all().length}`,
    `Validation issues: ${issues.length}`,
  ];
  if (status) status.textContent = lines.join('\n');
  console.info('[atlas]', Object.fromEntries(lines.map((l) => l.split(': '))));
}

boot().catch((err) => {
  console.error(err);
  const status = document.getElementById('status');
  if (status) status.textContent = `Startup failed: ${String(err)}`;
});
