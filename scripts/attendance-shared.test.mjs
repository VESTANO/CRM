// These pure shared modules use Deno.test only as a registration API. Execute
// the unchanged tests with Node's runner; this is not an Edge-runtime test.
import test from 'node:test';
globalThis.Deno = { test };
await import('../supabase/functions/_shared/attendance-identity.test.ts');
await import('../supabase/functions/_shared/attendance-login.test.ts');
await import('../supabase/functions/_shared/attendance-admin.test.ts');
