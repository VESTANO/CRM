import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const project = 'qdtgrddhpbwrutvojpes';
const cli = process.env.SUPABASE_CLI_BIN;
const folder = resolve('tmp/attendance-migration');
const keys = JSON.parse(execFileSync(cli, ['projects','api-keys',`--remote=${project}`,'--reveal','--output','json'], { encoding:'utf8', stdio:['ignore','pipe','pipe'] }));
const secret = (keys.find(k => k.name === 'service_role') || keys.find(k => k.type === 'secret')).api_key;
const publicKey = (keys.find(k => k.name === 'anon') || keys.find(k => k.type === 'publishable')).api_key;
async function api(path, { method='GET', body, token=secret } = {}) {
  const response = await fetch(`https://${project}.supabase.co${path}`, { method,
    headers:{ apikey: publicKey, Authorization:`Bearer ${token}`, 'Content-Type':'application/json' }, body:body && JSON.stringify(body) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}: ${data?.message || data?.msg || data?.detail || ''}`);
  return data;
}
const people = await api('/rest/v1/profiles?select=*');
const sourceFile = readdirSync(folder).filter(name => /^source-\d+\.json$/.test(name)).sort().at(-1);
const snapshot = JSON.parse(readFileSync(resolve(folder, sourceFile)));
if (process.argv.includes('--check-recovery')) {
  const person = people.find(p => p.active && p.role === 'employee');
  const generated = await api('/auth/v1/admin/generate_link', { method:'POST',body:{type:'recovery',email:person.email,redirect_to:'https://vestano.github.io/CRM/'} });
  const redirect = new URL(generated.action_link).searchParams.get('redirect_to');
  assert.equal(redirect?.toLowerCase(),'https://vestano.github.io/crm/');
  console.log('Password recovery redirect to the CRM page verified.');
}
if (process.argv.includes('--configure-device')) {
  const file = resolve(folder,'device-secrets.env');
  writeFileSync(file, `ATTENDANCE_ALLOWED_SERIALS=${snapshot.attendance_devices.map(d => d.serial_number).join(',')}\nATTENDANCE_TIMEZONE_OFFSET=+05:30\n`);
  execFileSync(cli,['secrets','set',`--remote=${project}`,'--env-file',file,'--yes'],{stdio:['ignore','pipe','pipe']});
  console.log('Configured receiver for the three existing device serials.');
}
async function session(person) {
  const generated = await api('/auth/v1/admin/generate_link',{method:'POST',body:{type:'magiclink',email:person.email}});
  const verified = await api('/auth/v1/verify',{method:'POST',body:{type:'email',token_hash:generated.hashed_token}});
  assert.equal(verified.user.id,person.id);
  return verified.access_token;
}
for (const role of ['employee','admin']) {
  const person = people.find(p => p.active && (role === 'admin' ? ['admin','super_admin'].includes(p.role) : p.role === role));
  const token = await session(person);
  const profile = await api(`/rest/v1/profiles?select=id&id=eq.${person.id}`,{token});
  assert.equal(profile[0].id,person.id);
  const punches = await api('/rest/v1/attendance_records?select=user_id&limit=1000',{token});
  if (role === 'employee') assert.ok(punches.every(row => row.user_id === person.id));
  const timesheets = await api('/rest/v1/timesheet_entries?select=user_id',{token});
  if (role === 'employee') assert.ok(timesheets.every(row => row.user_id === person.id));
  await api('/rest/v1/rpc/get_dashboard_totals',{method:'POST',body:{},token});
  const overtime = await api('/functions/v1/crm-api/api/overtime/',{token});
  assert.ok(Array.isArray(overtime.requests));
  console.log(`${role}: shared login, attendance visibility, timesheets, dashboard and OT API verified`);
}
if (process.argv.includes('--check-devices')) {
  const record=snapshot.attendance_records.find(row => row.raw?.includes('\t') && snapshot.attendance_devices.some(d=>d.serial_number===row.serial_number));
  if (!record) throw new Error('No original raw punch is available for the duplicate-delivery check.');
  for (const path of ['cdata','cdata.aspx']) {
    const response=await fetch(`https://${project}.supabase.co/functions/v1/iclock/iclock/${path}?SN=${encodeURIComponent(record.serial_number)}&table=ATTLOG`, {method:'POST',headers:{'Content-Type':'text/plain'},body:record.raw});
    const body=await response.text();
    assert.ok(response.ok && body.startsWith('OK:'),`Device endpoint ${path} failed (${response.status})`);
  }
  console.log('Direct CRM receiver and K90 .aspx compatibility verified with an existing duplicate punch.');
}
if (process.argv.includes('--send-resets')) {
  const originalProfilesFile = readdirSync(folder).filter(name => /^target-profiles-\d+\.json$/.test(name)).sort()[0];
  const originals = JSON.parse(readFileSync(resolve(folder,originalProfilesFile)));
  const normalize = value => String(value || '').trim().toLowerCase();
  const newlyMigrated = snapshot.profiles.filter(p => p.active && !originals.some(other => normalize(other.email) === normalize(p.email) || normalize(other.employee_id) === normalize(p.employee_id)));
  const sentFile = resolve(folder,'reset-sent.json');
  let sent;
  try { sent=JSON.parse(readFileSync(sentFile)); } catch { sent=[]; }
  for (const person of newlyMigrated) {
    if (sent.includes(person.id)) continue;
    await api('/auth/v1/recover?redirect_to=https%3A%2F%2Fvestano.github.io%2FCRM%2F',{method:'POST',body:{email:person.email}});
    sent.push(person.id); writeFileSync(sentFile,JSON.stringify(sent));
  }
  console.log(`Password reset invitations requested for ${sent.length} migrated accounts.`);
}
