import { expect, test, type Page } from '@playwright/test';
import { OWNER, recordedLinks, rpcAs, signIn } from './helpers';

// One lead with an e-mail and a mobile number in the synthetic seed.
const LEAD = 'Przychodnia Testowa 021';

async function openLead(page: Page) {
  await page.goto('/leady');
  await page.getByLabel('Szukaj: nazwa, NIP, e-mail, telefon').fill(LEAD);
  await expect(page.getByText('Wyniki: 1', { exact: false }).first()).toBeVisible();
  await page.getByRole('row', { name: new RegExp(LEAD) }).click();
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(LEAD) })).toBeVisible();
}

test.describe.serial('leads, card, calls, tasks, templates', () => {
  test('list: filters narrow the results and the saved view POZ applies', async ({ page }) => {
    await signIn(page);
    await page.goto('/leady');
    await expect(page.getByText('Wyniki: 300')).toBeVisible();

    // below 1500 px wide the filter column starts collapsed (E5)
    await page.getByRole('button', { name: 'Pokaż filtry' }).click();
    // register filter: kind switch to praktyki only
    await page.getByLabel('Praktyki zawodowe', { exact: true }).click();
    await expect(page.getByText('Wyniki: 180')).toBeVisible();
    await page.getByLabel('Podmioty lecznicze', { exact: true }).click();
    await expect(page.getByText('Wyniki: 120')).toBeVisible();

    // free text
    await page.getByLabel('Szukaj: nazwa, NIP, e-mail, telefon').fill(LEAD);
    await expect(page.getByText('Wyniki: 1', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(LEAD) })).toBeVisible();

    // saved system view POZ: a proper subset, shown in the URL and described under the summary
    await page.goto('/leady');
    await page.getByLabel('Widok', { exact: true }).selectOption({ label: 'POZ — podstawowa opieka zdrowotna' });
    await expect(page).toHaveURL(/view=\d+/);
    // expected count: the view's own filter evaluated by the database
    const ref = (await rpcAs(OWNER, 'ref_data')).body as { views: Array<{ name: string; filter: unknown }> };
    const view = ref.views.find((v) => v.name.startsWith('POZ'))!;
    const expected = ((await rpcAs(OWNER, 'leads_count', { p_filter: view.filter })).body as { total: number }).total;
    expect(expected).toBeGreaterThan(0);
    expect(expected).toBeLessThan(120);
    await expect(page.locator('.summary strong')).toHaveText(`Wyniki: ${expected}`);
    // the view is a podmioty view: no practice appears
    await expect(page.locator('table.grid tbody').getByText('Praktyka Testowa')).toHaveCount(0);
  });

  test('card: register data, timeline and a logged call outcome', async ({ page }) => {
    await signIn(page);
    await openLead(page);
    await expect(page.getByRole('tab', { name: /Historia/ })).toBeVisible();
    await page.getByRole('tab', { name: /Dane z rejestru/ }).click();
    await expect(page.getByRole('tabpanel')).toContainText(/NIP/);
    await page.getByRole('tab', { name: /Historia/ }).click();
    await expect(page.getByRole('tabpanel')).toContainText(/Import|rejestr/i);

    // call: the tel: link is recorded, then the outcome form opens
    await page.getByRole('group', { name: 'Szybkie akcje' }).getByRole('button', { name: 'Zadzwoń' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByText('Zapisz wynik kontaktu')).toBeVisible();
    expect((await recordedLinks(page)).some((l) => l.startsWith('tel:'))).toBe(true);
    await dlg.getByRole('button', { name: 'Rozmowa', exact: true }).click();
    await dlg.getByRole('textbox', { name: /Notatka/ }).fill('Rozmowa testowa e2e');
    await dlg.getByLabel('Nowy status').selectOption({ label: 'Kontakt nawiązany' });
    await dlg.getByRole('button', { name: 'za tydzień' }).first().click();
    await dlg.getByRole('button', { name: 'Zapisz', exact: true }).click();
    await expect(page.getByText('Rozmowa testowa e2e')).toBeVisible();
    await expect(page.locator('.controls select').first().locator('option:checked')).toHaveText('Kontakt nawiązany');
  });
});
