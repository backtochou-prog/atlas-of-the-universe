/** arXiv abstract pages (the export API rate-limits to 429 quickly; /abs pages are fine at ~1 request per 2 s). Cached. */
import type { DiscoveryCache } from './cache';

export interface ArxivAbs { id: string; url: string; title: string; authors: string[]; date: string; doi: string | null; abstract: string; retrieved: string }
const unesc = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export async function arxivAbs(cache: DiscoveryCache, id: string): Promise<ArxivAbs> {
  const url = `https://arxiv.org/abs/${id}`;
  const before = cache.retrieved('GET', url);
  const html = await cache.get(url, {}, `arXiv ${id}`, (t) => { if (!/citation_title/.test(t)) throw new Error(`arXiv ${id}: no citation_title in response`); });
  if (!before && !cache.offline) await new Promise((r) => setTimeout(r, 2500));
  const metas = (k: string) => [...html.matchAll(new RegExp(`<meta name="${k}" content="([^"]*)"`, 'g'))].map((m) => unesc(m[1]!));
  const ab = /<blockquote class="abstract[^>]*>([\s\S]*?)<\/blockquote>/.exec(html);
  if (!ab) throw new Error(`arXiv ${id}: abstract not found`);
  const abstract = unesc(ab[1]!.replace(/<[^>]+>/g, '')).replace(/^\s*Abstract:\s*/, '').replace(/\s+/g, ' ').trim();
  return { id, url, title: metas('citation_title')[0] ?? id, authors: metas('citation_author'), date: metas('citation_date')[0] ?? '', doi: metas('citation_doi')[0] ?? null, abstract, retrieved: cache.retrieved('GET', url) ?? 'unknown' };
}
