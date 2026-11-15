import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Resets the LOCAL Supabase database (migrations + synthetic seed) and creates the local test users through the local
// admin API. Refuses to run against anything but 127.0.0.1. No secret is printed or stored.
const ROOT = resolve(import.meta.dirname, '../..');
export const LOCAL_URL = 'http://127.0.0.1:54321';
export const LOCAL_PASSWORD = 'LocalTest-Only-1234';
export const USERS = ['owner@example.test', 'anna@example.test', 'piotr@example.test', 'stranger@example.test'];

function supabase(args: string[]): string {
  return execFileSync('npx', ['supabase@2.122.0', ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export default async function globalSetup() {
  const env: Record<string, string> = {};
  for (const line of supabase(['status', '-o', 'env']).split('\n')) {
    const m = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!;
  }
  if (!env.API_URL?.startsWith('http://127.0.0.1') || !env.SECRET_KEY) throw new Error('The local Supabase stack is not running (npx supabase start).');
  if (!process.env.E2E_SKIP_RESET) supabase(['db', 'reset']);
  for (const email of USERS) {
    const res = await fetch(`${env.API_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: env.SECRET_KEY, Authorization: `Bearer ${env.SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: LOCAL_PASSWORD, email_confirm: true }),
    });
    if (!res.ok && res.status !== 422) throw new Error(`creating local user failed: ${res.status}`);
  }
}
