#!/usr/bin/env node
// Validates tools/discovery/notes/relations.json (Relation[]) and, if present, stars-exo.json (DiscoveryNote[]).
// Plain node, no dependencies. Usage: node tools/discovery/notes/validate_relations.mjs [relations.json] [stars-exo.json]
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const relPath = process.argv[2] ?? join(here, 'relations.json');
const notesPath = process.argv[3] ?? join(here, 'stars-exo.json');

const BASIS = new Set(['physical-gravitational', 'structural', 'spatial-association', 'identity']);
const KIND = new Set(['orbits', 'member-of', 'component-of', 'part-of', 'near', 'same-object-as']);
const STATUS = new Set(['observed', 'inferred', 'hypothesis', 'historical']);
const ID_RE = /^(gaia|hip|solar|deep|point|exo|host|other):\S.*$/;
// Endpoints that belong to other agents' datasets: accepted, but reported so the lead resolves them at merge time.
const EXTERNAL = new Set(['solar:sun', 'deep:milky-way']);

const errors = [];
const notices = [];
const err = (m) => errors.push(m);
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

// ---- roster = ids of the notes this author owns -----------------------------------------------------
let notes = [];
if (existsSync(notesPath)) notes = JSON.parse(readFileSync(notesPath, 'utf8'));
const roster = new Set(notes.map((n) => n.id));

// ---- relations --------------------------------------------------------------------------------------
const rels = JSON.parse(readFileSync(relPath, 'utf8'));
if (!Array.isArray(rels)) err('relations.json must be an array');
const seen = new Set();
(Array.isArray(rels) ? rels : []).forEach((r, i) => {
  const at = `relation[${i}] ${r?.from} -> ${r?.to}`;
  for (const k of ['from', 'to']) {
    if (!isStr(r[k]) || !ID_RE.test(r[k])) err(`${at}: ${k} is not a universal id`);
  }
  if (r.from === r.to) err(`${at}: self relation`);
  if (!KIND.has(r.kind)) err(`${at}: illegal kind "${r.kind}"`);
  if (!BASIS.has(r.basis)) err(`${at}: illegal basis "${r.basis}"`);
  if (!isStr(r.statement)) err(`${at}: statement missing`);
  const s = r.source;
  if (!s || typeof s !== 'object') err(`${at}: source missing`);
  else {
    if (!isStr(s.label)) err(`${at}: source.label missing`);
    if (s.url !== undefined && !/^https:\/\/\S+$/.test(s.url)) err(`${at}: source.url is not an https url`);
    if (s.derivedFrom !== undefined && !isStr(s.derivedFrom)) err(`${at}: source.derivedFrom empty`);
    if (!s.url && !s.derivedFrom) err(`${at}: source needs a url (citation) or derivedFrom (dataset field)`);
    if (r.basis === 'physical-gravitational' && !s.url && !s.derivedFrom)
      err(`${at}: physical-gravitational without source.url or derivedFrom`);
    for (const extra of Object.keys(s)) if (!['label', 'url', 'derivedFrom'].includes(extra)) err(`${at}: unexpected source field "${extra}"`);
  }
  // kind/basis coherence
  if (r.kind === 'orbits' && r.basis !== 'physical-gravitational') err(`${at}: "orbits" must be physical-gravitational`);
  if (r.kind === 'near' && r.basis !== 'spatial-association') err(`${at}: "near" must be spatial-association`);
  if (r.kind === 'same-object-as' && r.basis !== 'identity') err(`${at}: "same-object-as" must be identity`);
  // endpoints
  for (const k of ['from', 'to']) {
    const id = r[k];
    if (roster.has(id)) continue;
    if (EXTERNAL.has(id)) { notices.push(`${at}: ${k} ${id} is outside this author's roster; resolve at merge`); continue; }
    err(`${at}: ${k} ${id} is neither in the roster (stars-exo.json) nor a flagged external id`);
  }
  const key = `${r.from}|${r.to}|${r.kind}`;
  if (seen.has(key)) err(`${at}: duplicate relation`);
  seen.add(key);
});

// ---- notes (light check of the NoteClaim rules) ----------------------------------------------------
const ids = new Set();
notes.forEach((n, i) => {
  const at = `note[${i}] ${n?.id}`;
  if (!ID_RE.test(n.id ?? '')) err(`${at}: bad id`);
  if (ids.has(n.id)) err(`${at}: duplicate id`);
  ids.add(n.id);
  if (!isStr(n.oneLine) || n.oneLine.length > 120) err(`${at}: oneLine missing or > 120 chars (${n.oneLine?.length})`);
  const sec = n.sections ?? {};
  if (!Array.isArray(sec.uncertain) || sec.uncertain.length < 1) err(`${at}: uncertain section needs at least one claim`);
  for (const k of ['what', 'why']) if (!Array.isArray(sec[k]) || sec[k].length < 1) err(`${at}: section ${k} empty`);
  for (const [name, claims] of Object.entries(sec)) {
    if (!['what', 'why', 'discovery', 'interesting', 'uncertain'].includes(name)) err(`${at}: unknown section ${name}`);
    (claims ?? []).forEach((c, j) => {
      const cat = `${at} ${name}[${j}]`;
      if (!isStr(c.text)) err(`${cat}: text missing`);
      if (!STATUS.has(c.status)) err(`${cat}: illegal status "${c.status}"`);
      if (!Array.isArray(c.references) || c.references.length < 1) err(`${cat}: no reference`);
      (c.references ?? []).forEach((ref) => {
        if (!isStr(ref.label) || !/^https:\/\/\S+$/.test(ref.url ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(ref.retrieved ?? ''))
          err(`${cat}: reference needs label, https url and YYYY-MM-DD retrieved`);
      });
    });
  }
  (n.studiedBy ?? []).forEach((s, j) => {
    if (!isStr(s.mission) || !isStr(s.role) || !/^https:\/\//.test(s.reference?.url ?? '')) err(`${at} studiedBy[${j}]: incomplete`);
  });
  if (!(n.studiedBy ?? []).length) notices.push(`${at}: studiedBy is empty`);
});

for (const n of notices) console.log('notice:', n);
if (errors.length) {
  for (const e of errors) console.error('ERROR:', e);
  console.error(`\n${errors.length} error(s)`);
  process.exit(1);
}
console.log(`OK: ${Array.isArray(rels) ? rels.length : 0} relations, ${notes.length} notes validated`);
