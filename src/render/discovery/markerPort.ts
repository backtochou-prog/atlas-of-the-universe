/**
 * What the viewer (R2a) accepts for highlights and the selection proxy. Viewer.setHighlights / setSelectionProxy forward them to R2b's HighlightMarkers
 * (src/render/deep-space/DiscoveryMarkers.ts, found with findDiscoveryMarkers); with none registered the viewer still stores the state (viewer.highlights,
 * viewer.selectionProxy) so the page can draw a DOM fallback from viewer.projectPc.
 */
import type { Vec3 } from '../../core/spatial/vec3';

export interface HighlightItem {
  /** Universal id of the object. */
  readonly id: string;
  /** Heliocentric ICRS parsecs (float64). Solar System bodies are converted by the caller at the current simulation time. */
  readonly positionPc: Vec3;
  /** Optional name drawn next to the ring. */
  readonly label?: string;
}

export interface SelectionProxy extends HighlightItem {
  readonly label: string;
  /** Physical radius of the object, pc (extended objects): the ring is hidden when the object spans several pixels. Optional. */
  readonly sizePc?: number;
  /** Absolute magnitude (stars): the ring is hidden when the star is clearly drawn. Optional. */
  readonly absoluteMag?: number;
  /** Why a proxy is drawn: "planets are not drawn; the marker shows the host star". */
  readonly reason: string;
}
