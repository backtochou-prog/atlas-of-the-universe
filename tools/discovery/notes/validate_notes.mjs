#!/usr/bin/env node
// Validates tools/discovery/notes/solar-deep.json (DiscoveryNote[]; see src/discovery/types.ts).
// Usage: node tools/discovery/notes/validate_notes.mjs [file ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const files = process.argv.length > 2 ? process.argv.slice(2) : [path.join(here, 'solar-deep.json')];
const STATUS = new Set(['observed', 'inferred', 'hypothesis', 'historical']);
const REQUIRED = ['what', 'why', 'uncertain'];
const OPTIONAL = ['discovery', 'interesting'];
const ONE_LINE_MAX = 120, MAX_CLAIMS = 3;
const errors = [];
const err = (id, m) => errors.push(`${id}: ${m}`);
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

// Known atlas ids (solar bodies + deep objects) for existence checks.
const atlasIds = new Set();
try {
  for (const b of JSON.parse(fs.readFileSync(path.join(root, 'public/data/solar-system.v1.json'), 'utf8')).bodies) atlasIds.add('solar:' + b.id);
  for (const o of JSON.parse(fs.readFileSync(path.join(root, 'public/data/deep-space.v1.json'), 'utf8')).objects) atlasIds.add('deep:' + o.id);
} catch (e) { console.warn('warning: atlas data not readable, id existence check skipped:', e.message); atlasIds.clear(); }

function checkRef(id, where, r, needDate) {
  if (!r || typeof r !== 'object') return err(id, `${where}: reference missing`);
  if (typeof r.label !== 'string' || !r.label.trim()) err(id, `${where}: reference label empty`);
  if (typeof r.url !== 'string' || !/^https:\/\/[^\s/]+\.[^\s/]+\S*$/.test(r.url)) err(id, `${where}: reference url not https (${r.url})`);
  if (needDate && !(typeof r.retrieved === 'string' && isoDate.test(r.retrieved))) err(id, `${where}: retrieved date missing/invalid`);
}
function checkClaim(id, where, c) {
  if (!c || typeof c.text !== 'string' || !c.text.trim()) return err(id, `${where}: claim text empty`);
  if (emoji.test(c.text)) err(id, `${where}: emoji in text`);
  if (c.text.length > 420) err(id, `${where}: claim longer than 420 chars (${c.text.length})`);
  if (!STATUS.has(c.status)) err(id, `${where}: bad status ${c.status}`);
  if (!Array.isArray(c.references) || c.references.length < 1) err(id, `${where}: needs >= 1 reference`);
  else c.references.forEach((r, i) => checkRef(id, `${where}.references[${i}]`, r, true));
}

let total = 0, claims = 0;
for (const f of files) {
  const notes = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!Array.isArray(notes)) { err(f, 'top level must be an array'); continue; }
  const seen = new Set();
  for (const n of notes) {
    total++;
    const id = n.id ?? '(no id)';
    if (typeof n.id !== 'string' || !/^(solar|deep):[a-z0-9-]+$/.test(n.id)) err(id, 'id must be solar:* or deep:*');
    if (seen.has(n.id)) err(id, 'duplicate id'); seen.add(n.id);
    if (atlasIds.size && !atlasIds.has(n.id)) err(id, 'id not found in atlas data');
    if (typeof n.oneLine !== 'string' || !n.oneLine.trim()) err(id, 'oneLine missing');
    else {
      if (n.oneLine.length > ONE_LINE_MAX) err(id, `oneLine ${n.oneLine.length} > ${ONE_LINE_MAX}`);
      if (emoji.test(n.oneLine)) err(id, 'emoji in oneLine');
    }
    const s = n.sections;
    if (!s || typeof s !== 'object') { err(id, 'sections missing'); continue; }
    for (const k of REQUIRED) if (!Array.isArray(s[k]) || s[k].length < 1) err(id, `sections.${k} needs >= 1 claim`);
    for (const k of [...REQUIRED, ...OPTIONAL]) {
      if (s[k] === undefined) continue;
      if (!Array.isArray(s[k])) { err(id, `sections.${k} not an array`); continue; }
      if (s[k].length > MAX_CLAIMS) err(id, `sections.${k} has ${s[k].length} claims (max ${MAX_CLAIMS})`);
      s[k].forEach((c, i) => { claims++; checkClaim(id, `sections.${k}[${i}]`, c); });
    }
    for (const k of Object.keys(s)) if (![...REQUIRED, ...OPTIONAL].includes(k)) err(id, `unknown section ${k}`);
    if (!Array.isArray(n.studiedBy) || n.studiedBy.length < 1) err(id, 'studiedBy needs >= 1 entry');
    else n.studiedBy.forEach((m, i) => {
      if (!m.mission || !m.role) err(id, `studiedBy[${i}]: mission/role missing`);
      checkRef(id, `studiedBy[${i}].reference`, m.reference, false);
    });
  }
}
console.log(`notes: ${total}, claims: ${claims}, errors: ${errors.length}`);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('OK');
