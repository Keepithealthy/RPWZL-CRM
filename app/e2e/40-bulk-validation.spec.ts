import { expect, test } from '@playwright/test';
import { OWNER, rpcAs, signIn } from './helpers';

test('bulk status change applies to the selected leads only', async ({ page }) => {
  await signIn(page);
  await page.goto('/leady');
  await page.getByLabel('Szukaj: nazwa, NIP, e-mail, telefon').fill('Przychodnia Testowa 03');
  await expect(page.locator('.summary strong')).toHaveText(/Wyniki: (9|10)$/); // 030..039 (may include 003x names only)
  const rows = page.locator('table.grid tbody tr');
  await rows.nth(0).getByRole('checkbox').check();
  await rows.nth(1).getByRole('checkbox').check();
  const names = [await rows.nth(0).locator('td').nth(1).innerText(), await rows.nth(1).locator('td').nth(1).innerText()];
  const bar = page.getByRole('region', { name: 'Akcje zbiorcze' });
  await expect(bar).toContainText('Zaznaczono: 2');
  await bar.getByLabel('Akcja zbiorcza').selectOption({ label: 'Zmień status' });
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Nowy status').selectOption({ label: 'Zainteresowany' });
  await dlg.getByRole('button', { name: 'Zastosuj' }).click();
  await expect(page.getByText(/Zmieniono status: 2/)).toBeVisible();

  // database state: exactly two leads of that search are now "Zainteresowany"
  const res = (await rpcAs(OWNER, 'leads_search', { p_filter: { q: 'Przychodnia Testowa 03' }, p_sort: null, p_offset: 0, p_limit: 50 })).body as { rows: Array<{ name: string; statusId: number }> };
  const changed = res.rows.filter((r) => r.statusId === 4).map((r) => r.name).sort();
  expect(changed).toHaveLength(2);
  for (const n of names) expect(changed.some((c) => n.includes(c) || c.includes(n.trim()))).toBe(true);
});

test.describe.serial('Walidacja', () => {
  test('confirming and rejecting proposals persists across a reload', async ({ page }) => {
    await signIn(page);
    await page.goto('/walidacja');
    const tab = page.getByRole('tab', { name: /^Konta \(/ });
    const openCount = async () => Number(/\((\d+)\)/.exec((await tab.textContent()) ?? '')![1]);
    await expect(tab).toBeVisible();
    const before = await openCount();
    expect(before).toBeGreaterThanOrEqual(2);

    const cards = page.locator('article.val-card');
    // confirm the first proposal
    await cards.first().click();
    await cards.first().getByRole('button', { name: /To ten sam podmiot/ }).click();
    await expect.poll(openCount).toBe(before - 1);
    // reject the (new) first proposal
    await cards.first().click();
    await cards.first().getByRole('button', { name: /To różne podmioty/ }).click();
    await expect.poll(openCount).toBe(before - 2);

    // persisted: reload, counts stay, decided proposals show under their own filters
    await page.reload();
    await expect(tab).toBeVisible();
    expect(await openCount()).toBe(before - 2);
    await page.locator('.val-toolbar select').nth(1).selectOption({ label: 'Potwierdzone' });
    await expect(page.locator('article.val-card')).toHaveCount(1);
    await expect(page.locator('article.val-card .badge', { hasText: 'potwierdzone' }).first()).toBeVisible();
    await page.locator('.val-toolbar select').nth(1).selectOption({ label: 'Odrzucone' });
    await expect(page.locator('article.val-card')).toHaveCount(1);
    await expect(page.locator('article.val-card').first()).toContainText('odrzucone');

    // and the database agrees (two decided proposals)
    const summary = (await rpcAs(OWNER, 'val_summary', { p_filter: null })).body as { queues: { accounts: { open: number; decided: number } } };
    expect(summary.queues.accounts.open).toBe(before - 2);
    expect(summary.queues.accounts.decided).toBe(2);
  });

  test('a decision can be reverted ("Cofnij decyzję")', async ({ page }) => {
    await signIn(page);
    await page.goto('/walidacja');
    await page.locator('.val-toolbar select').nth(1).selectOption({ label: 'Odrzucone' });
    const card = page.locator('article.val-card').first();
    await card.getByRole('button', { name: 'Cofnij decyzję' }).click();
    await expect(page.locator('article.val-card')).toHaveCount(0);
    await page.locator('.val-toolbar select').nth(1).selectOption({ label: 'Otwarte' });
    await expect(page.getByRole('tab', { name: /^Konta \(/ })).toContainText(/\(\d+\)/);
  });
});
