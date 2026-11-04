// Run with --apply only after applying the unified attendance schema.
// API keys remain in process memory; snapshots go into ignored tmp/.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const source = 'lorrfeyiqgdfxdjqnpmn';
const target = 'qdtgrddhpbwrutvojpes';
const cli = process.env.SUPABASE_CLI_BIN;
if (!cli) throw new Error('Set SUPABASE_CLI_BIN to the installed Supabase CLI executable.');
const apply = process.argv.includes('--apply');
const folder = resolve('tmp/attendance-migration');
mkdirSync(folder, { recursive: true });
function command(args) {
  return JSON.parse(execFileSync(cli, args, { encoding: 'utf8', maxBuffer: 80 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
}
function query(project, sql) {
  const file = resolve(folder, 'read.sql');
  writeFileSync(file, sql);
  const result = command(['db', 'query', `--remote=${project}`, '--read-only', '--file', file]);
  if (!result.rows) throw new Error('Database query failed: ' + JSON.stringify(result));
  return result.rows;
}
function key(project) {
  const result = command(['projects', 'api-keys', `--remote=${project}`, '--reveal', '--output', 'json']);
  const keys = Array.isArray(result) ? result : result.api_keys;
  const entry = keys.find(k => k.id === 'service_role' || k.name === 'service_role') || keys.find(k => k.type === 'secret');
  if (!entry?.api_key) throw new Error('No migration service key available.');
  return entry.api_key;
}
const sourceKey = key(source);
const targetKey = key(target);
async function api(project, secret, path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`https://${project}.supabase.co${path}`, {
    method, headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${data?.message || data?.msg || data?.error_description || ''}`);
  return data;
}
async function rows(project, secret, table) {
  const result = [];
  for (let offset = 0; ; offset += 500) {
    const page = await api(project, secret, `/rest/v1/${table}?select=*&order=${table === 'attendance_mappings' ? 'punch_code' : table === 'attendance_devices' ? 'serial_number' : 'id'}&offset=${offset}&limit=500`);
    result.push(...page);
    if (page.length < 500) return result;
  }
}
const tables = ['profiles', 'app_settings', 'attendance_devices', 'attendance_mappings', 'attendance_records', 'timesheet_entries'];
const snapshot = Object.fromEntries(await Promise.all(tables.map(async table => [table, await rows(source, sourceKey, table)])));
const destination = await rows(target, targetKey, 'profiles');
// Backup both sets of profiles before any hosted writes. No credentials saved.
writeFileSync(resolve(folder, `source-${Date.now()}.json`), JSON.stringify(snapshot));
writeFileSync(resolve(folder, `target-profiles-${Date.now()}.json`), JSON.stringify(destination));
const normalize = value => String(value || '').trim().toLowerCase();
const mapping = new Map();
const missing = [];
for (const person of snapshot.profiles) {
  const matches = destination.filter(other => normalize(other.employee_id) === normalize(person.employee_id) || normalize(other.email) === normalize(person.email));
  if (matches.length > 1) throw new Error(`Conflicting identity matches for ${person.employee_id}; resolve before migration.`);
  if (matches.length) mapping.set(person.id, matches[0]); else missing.push(person);
}
console.log(JSON.stringify({ sourceRows: Object.fromEntries(tables.map(t => [t, snapshot[t].length])), matchedUsers: mapping.size, newUsers: missing.map(p => p.employee_id), apply }));
if (!apply) process.exit(0);
// Create unmatched accounts without replacing any existing CRM credentials.
// Password-setup emails are sent separately after the cutover is verified.
for (const person of missing) {
  const result = await api(target, targetKey, '/auth/v1/admin/users', { method: 'POST', body: {
    email: person.email, email_confirm: true,
    user_metadata: { employee_id: person.employee_id, name: person.name, attendance_migrated: true },
  } });
  const user = result.user || result;
  const profile = { ...person, id: user.id };
  await api(target, targetKey, '/rest/v1/profiles?on_conflict=id', { method: 'POST', body: profile,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  destination.push(profile); mapping.set(person.id, profile);
}
for (const person of snapshot.profiles) {
  const mapped = mapping.get(person.id);
  const changes = { shift_start_time: person.shift_start_time, shift_end_time: person.shift_end_time };
  if (!mapped.profile_image && person.profile_image) changes.profile_image = person.profile_image;
  await api(target, targetKey, `/rest/v1/profiles?id=eq.${mapped.id}`, { method: 'PATCH', body: changes, headers: { Prefer: 'return=minimal' } });
}
function mappedRows(table) {
  return snapshot[table].map(row => {
    if (!('user_id' in row) || row.user_id === null) return row;
    const user = mapping.get(row.user_id);
    if (!user) throw new Error(`Unmapped identity in ${table}`);
    return { ...row, user_id: user.id, ...('employee_id' in row ? { employee_id: user.employee_id, employee_name: user.name } : {}) };
  });
}
const conflicts = { app_settings: 'id', attendance_devices: 'serial_number', attendance_mappings: 'punch_code', attendance_records: 'serial_number,punch_code,punched_at', timesheet_entries: 'id' };
for (const table of tables.filter(t => t !== 'profiles')) {
  const records = mappedRows(table);
  for (let offset = 0; offset < records.length; offset += 250) {
    await api(target, targetKey, `/rest/v1/${table}?on_conflict=${conflicts[table]}`, { method: 'POST', body: records.slice(offset, offset + 250), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  }
  const copied = await rows(target, targetKey, table);
  const identity = row => conflicts[table].split(',').map(k => row[k]).join('|');
  const copiedKeys = new Set(copied.map(identity));
  if (!records.every(row => copiedKeys.has(identity(row)))) throw new Error(`Incomplete migration: ${table}`);
  console.log(`${table}: verified ${records.length} source records`);
}
writeFileSync(resolve(folder, 'identity-map.json'), JSON.stringify(Object.fromEntries([...mapping].map(([oldId, profile]) => [oldId, profile.id]))));
writeFileSync(resolve(folder, 'device-secrets.env'), `ATTENDANCE_ALLOWED_SERIALS=${snapshot.attendance_devices.map(row => row.serial_number).join(',')}\nATTENDANCE_TIMEZONE_OFFSET=+05:30\n`);
console.log('Migration data verified. New accounts need password-reset invitations; no credentials were replaced.');
