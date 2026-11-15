import { expect, test, type Page } from '@playwright/test';
import { OWNER, indexFile, rpcAs, signIn, standardDataset } from './helpers';

// Runs last (file name order): it imports a synthetic file that does not contain the seed entries, so the seed entries
// are reported as "zniknęły z rejestru" and the other specs must not depend on them any more.

async function pick(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.getByLabel('Plik indeksu rejestru').setInputFiles(file);
}

async function confirmPreview(page: Page) {
  await expect(page.getByRole('heading', { name: 'Co się zmieni' })).toBeVisible({ timeout: 60_000 });
  for (const box of await page.locator('fieldset.imp-warn input[type=checkbox]').all()) await box.check();
  await page.getByRole('button', { name: 'Zatwierdź import' }).click();
}

test.describe.serial('Import', () => {
  test('a version 1 index is refused with an explanation, nothing is written', async ({ page }) => {
    await signIn(page);
    await page.goto('/import');
    const { p, r } = standardDataset();
    await pick(page, await indexFile('rpwdl-index-v1.json.gz', { version: 1, p, r, today: '2026-11-15' }));
    await expect(page.getByRole('alert')).toContainText(/wersj/i);
    await expect(page.getByRole('heading', { name: 'Co się zmieni' })).toHaveCount(0);
    const runs = (await rpcAs(OWNER, 'import_runs')).body as unknown[];
    expect(runs).toHaveLength(1); // only the seed run
  });

  test('a version 2 index imports, shows the diff, and a second import of the same file changes nothing', async ({ page }) => {
    await signIn(page);
    // CRM work that must survive the import (the seed entries are all about to disappear from the register)
    const seeds = (await rpcAs(OWNER, 'leads_search', { p_filter: { q: 'Przychodnia Testowa 05' }, p_sort: null, p_offset: 0, p_limit: 2 })).body as { rows: Array<{ id: number; version: number }> };
    for (const row of seeds.rows) {
      const res = await rpcAs(OWNER, 'lead_update', { p_entry_id: row.id, p_version: row.version, p_patch: { statusId: 6 } });
      expect(res.status).toBe(200);
    }
    const worked = seeds.rows.map((x) => x.id).sort();

    await page.goto('/import');
    const { p, r } = standardDataset();
    const file = await indexFile('rpwdl-index-v2.json.gz', { version: 2, p, r, today: '2026-11-15' });
    await pick(page, file);
    await expect(page.getByRole('heading', { name: 'Co się zmieni' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Wczytane wpisy')).toBeVisible();
    await confirmPreview(page);
    await expect(page.getByRole('heading', { name: 'Import zakończony' })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/Statusy, notatki, zadania i decyzje walidacji zostały bez zmian/)).toBeVisible();

    // the new entries are searchable; the data-age line moved to the new report date
    await expect(page.getByText('Dane z rejestru: stan na 15.11.2026')).toBeVisible({ timeout: 15_000 });
    const found = (await rpcAs(OWNER, 'leads_count', { p_filter: { inRegister: 'yes' } })).body as { total: number };
    // the file declares Rpm/Rpz/Rpzg/Rpzp; the 45 seed entries of source Rpf (not in the file) are left alone
    expect(found.total).toBe(p.length + r.length + 45);
    const runs = (await rpcAs(OWNER, 'import_runs')).body as Array<{ status: string; counts: { new: number; gone: number } | null }>;
    const last = runs.find((x) => x.counts?.new === p.length + r.length)!;
    expect(last.status).toBe('applied');
    expect(last.counts!.gone).toBe(255); // 300 seed entries - 45 of the undeclared source

    // the diff screen lists the changes of this run
    await page.getByRole('button', { name: 'Zobacz zmiany' }).click();
    await expect(page.getByRole('heading', { name: 'Zmiany z importu' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Nowe/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Zniknęły/ })).toBeVisible();
    await page.getByRole('button', { name: 'Zamknij' }).click();

    // CRM-entered data is untouched, also on entries that left the register
    const after = (await rpcAs(OWNER, 'leads_search', { p_filter: { status: [6], inRegister: 'all' }, p_sort: null, p_offset: 0, p_limit: 50 })).body as { rows: Array<{ id: number; inRegister: boolean }> };
    expect(after.rows.map((x) => x.id).sort()).toEqual(worked);
    expect(after.rows.every((x) => !x.inRegister)).toBe(true);

    // second import of the very same file: nothing to send
    await page.getByRole('button', { name: 'Wczytaj kolejny plik' }).click();
    await pick(page, file);
    await expect(page.getByText('Baza jest już zgodna z tym plikiem')).toBeVisible({ timeout: 60_000 });
  });
});
