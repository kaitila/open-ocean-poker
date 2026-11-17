// Import the real line-up from a CSV (e.g. exported from Luma / Google Sheets).
//
//   node scripts/import-csv.js players.csv
//
// Columns (header row, case-insensitive, extra columns are ignored):
//   name*, table*, seat, title, company, role (founder|investor|operator),
//   photo (image URL), linkedin, bio, first_timer (yes/no), host (yes/no), id
//
// Writes data/players.json and data/tables.json. Table names come from the
// "table" column: "A" becomes "Table A", "Table 3" stays as it is.
// Then hit "Reload data files" on /#/admin (or restart the server).
const fs = require('fs');
const path = require('path');

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/import-csv.js players.csv'); process.exit(1); }
const [header, ...rows] = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const key = (h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_');
const cols = header.map(key);
const truthy = (v) => /^(y|yes|true|1|x)$/i.test(String(v || '').trim());
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');

const tables = new Map();
const used = new Set();
const players = rows.map((r) => {
  const o = Object.fromEntries(cols.map((c, i) => [c, (r[i] || '').trim()]));
  if (!o.name) return null;
  const rawTable = o.table || '?';
  const tid = slug(rawTable.replace(/^table\s*/i, '')).toUpperCase() || '?';
  if (!tables.has(tid)) tables.set(tid, { id: tid, name: /^table/i.test(rawTable) ? rawTable : `Table ${rawTable}` });
  let id = o.id || slug(o.name);
  while (used.has(id)) id += '-2';
  used.add(id);
  return {
    id, name: o.name, title: o.title || '', company: o.company || '',
    role: (o.role || '').toLowerCase(), table: tid, seat: o.seat ? Number(o.seat) : null,
    photo: o.photo || o.photo_url || o.avatar || '', linkedin: o.linkedin || o.linkedin_url || '', bio: o.bio || '',
    firstTimer: truthy(o.first_timer || o.firsttimer), host: truthy(o.host),
  };
}).filter(Boolean);

const sortedTables = [...tables.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
const dir = path.join(__dirname, '..', 'data');
fs.writeFileSync(path.join(dir, 'tables.json'), JSON.stringify(sortedTables, null, 2) + '\n');
fs.writeFileSync(path.join(dir, 'players.json'), JSON.stringify(players, null, 2) + '\n');
console.log(`Imported ${players.length} players across ${sortedTables.length} tables.`);
