import { expect, type Page } from '@playwright/test';
import { LOCAL_PASSWORD, LOCAL_URL } from './global-setup';
import { buildIndex, fakePodmiot, fakePraktyka, gzipText, standardDataset, type IndexOpts } from '../src/features/import/fixtures';

export const OWNER = 'owner@example.test';
export const MEMBER = 'anna@example.test';
// Public local-development key of the Supabase CLI stack (publishable, not a secret); only valid on 127.0.0.1.
export const LOCAL_PUBLISHABLE_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

/** Headless Chrome has no handler for tel:/sms:/mailto:; record the link instead of following it. */
export async function stubExternalLinks(page: Page) {
  await page.addInitScript(() => {
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (/^(tel|sms|mailto):/.test(this.href)) {
        const w = window as unknown as { __links?: string[] };
        w.__links = [...(w.__links ?? []), this.href];
        return;
      }
      return orig.call(this);
    };
  });
}

export async function recordedLinks(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __links?: string[] }).__links ?? []);
}

export async function signIn(page: Page, email: string = OWNER) {
  await stubExternalLinks(page);
  await page.goto('/');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Hasło').fill(LOCAL_PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj' }).click();
  await expect(page.getByRole('navigation', { name: 'Menu główne' })).toBeVisible();
}

/** Calls an `api` RPC over HTTP exactly as the browser would, as the given local user. Returns status and body. */
export async function rpcAs(email: string, name: string, args: Record<string, unknown> = {}) {
  const auth = await fetch(`${LOCAL_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: LOCAL_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: LOCAL_PASSWORD }),
  });
  const token = ((await auth.json()) as { access_token?: string }).access_token;
  const res = await fetch(`${LOCAL_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: LOCAL_PUBLISHABLE_KEY, Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json', 'Content-Profile': 'api', 'Accept-Profile': 'api' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
}

/** A gzip-compressed synthetic index as a Playwright file payload. */
export async function indexFile(name: string, o: IndexOpts) {
  const gz = await gzipText(buildIndex(o));
  return { name, mimeType: 'application/gzip', buffer: Buffer.from(gz) };
}

export { buildIndex, fakePodmiot, fakePraktyka, standardDataset };
