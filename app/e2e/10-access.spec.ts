import { expect, test } from '@playwright/test';
import { MEMBER, OWNER, rpcAs, signIn } from './helpers';

test('owner sees Import, Eksport, Użytkownicy and Ustawienia', async ({ page }) => {
  await signIn(page, OWNER);
  const nav = page.getByRole('navigation', { name: 'Menu główne' });
  for (const name of ['Import', 'Eksport i kopia', 'Użytkownicy', 'Ustawienia']) await expect(nav.getByRole('link', { name })).toBeVisible();
});

test('member does not see owner screens and the owner routes do not render for them', async ({ page }) => {
  await signIn(page, MEMBER);
  const nav = page.getByRole('navigation', { name: 'Menu główne' });
  for (const name of ['Dziś', 'Leady', 'Walidacja']) await expect(nav.getByRole('link', { name })).toBeVisible();
  for (const name of ['Import', 'Eksport i kopia', 'Użytkownicy', 'Ustawienia']) await expect(nav.getByRole('link', { name })).toHaveCount(0);
  await page.goto('/eksport');
  await expect(page.getByRole('heading', { name: 'Eksport i kopia danych' })).toHaveCount(0);
  await page.goto('/import');
  await expect(page.getByRole('heading', { name: 'Krok 1. Wybierz plik' })).toHaveCount(0);
  // no bulk export on the list either
  await page.goto('/leady');
  await expect(page.getByText(/Wyniki: \d/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Eksport/ })).toHaveCount(0);
});

test('the export, backup and import RPCs reject a member (CR403) and a stranger (CR402)', async () => {
  const target = { filter: {} };
  for (const [name, args] of [
    ['export_begin', { p_target: target, p_format: 'csv', p_options: {} }],
    ['backup_export', { p_table: 'lead', p_offset: 0, p_limit: 10 }],
    ['import_runs', {}],
    ['members_list', {}],
    ['db_usage', {}],
  ] as const) {
    const res = await rpcAs(MEMBER, name, args);
        expect((res.body as { code?: string }).code, name).toBe('CR403');
  }
  const stranger = await rpcAs('stranger@example.test', 'me');
  expect((stranger.body as { code?: string }).code).toBe('CR402');
  const owner = await rpcAs(OWNER, 'export_begin', { p_target: target, p_format: 'csv', p_options: {} });
  expect(owner.status).toBe(200);
});
