#!/usr/bin/env node
/** Merge the authored notes/relations sources into the two files the app loads.
 *  node tools/discovery/build_notes.mjs   ->  public/data/discovery-notes.v1.json, public/data/relations.v1.json */
import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url).pathname;
const read = (p) => JSON.parse(readFileSync(root + p, 'utf8'));
const arr = (x) => (Array.isArray(x) ? x : x.notes ?? x.relations ?? []);
const notes = [...arr(read('tools/discovery/notes/solar-deep.json')), ...arr(read('tools/discovery/notes/stars-exo.json'))];
const seen = new Set();
for (const n of notes) { if (seen.has(n.id)) throw new Error(`duplicate note ${n.id}`); seen.add(n.id); }
const today = new Date().toISOString().slice(0, 10);
writeFileSync(root + 'public/data/discovery-notes.v1.json', JSON.stringify({
  manifest: { schema: 'atlas-discovery-notes/1', generated: today, policy: 'Every statement is a claim with at least one reference (url, retrieval date). Claims paraphrase pages and abstracts retrieved on the stated date; they are not independent measurements. Status: observed, inferred, hypothesis (including open questions) or historical.' },
  notes,
}, null, 1));
const relations = arr(read('tools/discovery/notes/relations.json'));
writeFileSync(root + 'public/data/relations.v1.json', JSON.stringify({ manifest: { schema: 'atlas-relations/1', generated: today }, relations }, null, 1));
console.log(`notes ${notes.length}, claims ${notes.reduce((a, n) => a + Object.values(n.sections).reduce((b, s) => b + s.length, 0), 0)}, relations ${relations.length}`);
