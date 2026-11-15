import { expect, test, type Page } from '@playwright/test';
import { recordedLinks, signIn } from './helpers';

const LEAD = 'Przychodnia Testowa 021'; // synthetic: has an e-mail and a mobile number

function localIso(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function openLead(page: Page) {
  await page.goto('/leady');
  await page.getByLabel('Szukaj: nazwa, NIP, e-mail, telefon').fill(LEAD);
  await expect(page.locator('.summary strong')).toHaveText('Wyniki: 1');
  await page.getByRole('row', { name: new RegExp(LEAD) }).click();
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(LEAD) })).toBeVisible();
}

test.describe.serial('tasks and templates', () => {
  test('a task created on the card shows up on Dziś', async ({ page }) => {
    await signIn(page);
    await openLead(page);
    await page.getByRole('group', { name: 'Szybkie akcje' }).getByRole('button', { name: 'Zadanie' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Tytuł zadania').fill('Zadzwonić z ofertą e2e');
    await dlg.getByLabel('Termin', { exact: true }).fill(localIso());
    await dlg.getByRole('button', { name: 'Zapisz', exact: true }).click();
    await expect(dlg).toHaveCount(0);

    await page.getByRole('link', { name: 'Dziś' }).click();
    await expect(page.getByRole('heading', { name: /Zadania na dziś/ })).toBeVisible();
    await expect(page.getByText('Zadzwonić z ofertą e2e')).toBeVisible();
    await expect(page.getByRole('link', { name: LEAD }).first()).toBeVisible();
  });

  test('an SMS template is created, previewed and used in an sms: link; an e-mail template in a mailto: link', async ({ page }) => {
    await signIn(page);
    await page.goto('/szablony');
    // SMS template
    await page.getByRole('tab', { name: 'SMS' }).click();
    await page.getByRole('button', { name: 'Nowy szablon' }).click();
    await page.getByLabel('Nazwa szablonu').fill('Test e2e SMS');
    await page.getByLabel('Treść').fill('Dzien dobry, pisze {{opiekun}} z KIH do {{nazwa}} ({{miasto}}).');
    await expect(page.locator('.preview-text')).toContainText('KIH do');
    await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Test e2e SMS' })).toBeVisible();
    // e-mail template
    await page.getByRole('tab', { name: 'E-mail' }).click();
    await page.getByRole('button', { name: 'Nowy szablon' }).click();
    await page.getByLabel('Nazwa szablonu').fill('Test e2e mail');
    await page.getByLabel('Temat').fill('Wspolpraca z {{nazwa}}');
    await page.getByLabel('Treść').fill('Szanowni Panstwo, kontakt w sprawie oferty.');
    await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Test e2e mail' })).toBeVisible();

    // use them on the card
    await openLead(page);
    const quick = page.getByRole('group', { name: 'Szybkie akcje' });
    await quick.getByRole('button', { name: 'SMS' }).click();
    let dlg = page.getByRole('dialog');
    await dlg.getByLabel('Szablon').selectOption({ label: 'Test e2e SMS' });
    await expect(dlg.getByLabel('Treść')).toHaveValue(new RegExp(`do ${LEAD}`));
    await dlg.getByRole('button', { name: 'Otwórz w telefonie' }).click();
    const links = await recordedLinks(page);
    const sms = links.find((l) => l.startsWith('sms:'))!;
    expect(sms).toMatch(/^sms:\+48600000021\?body=/);
    expect(decodeURIComponent(sms)).toContain(`do ${LEAD}`);
    // the outcome form follows; skip it
    await expect(page.getByRole('dialog').getByText('Zapisz wynik kontaktu')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Zapisz', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await quick.getByRole('button', { name: 'E-mail' }).click();
    dlg = page.getByRole('dialog');
    await dlg.getByLabel('Szablon').selectOption({ label: 'Test e2e mail' });
    await dlg.getByRole('button', { name: 'Otwórz w programie pocztowym' }).click();
    const mail = (await recordedLinks(page)).find((l) => l.startsWith('mailto:'))!;
    expect(mail).toMatch(/^mailto:rejestracja@klinika21\.example\?subject=/);
    expect(decodeURIComponent(mail)).toContain(`Wspolpraca z ${LEAD}`);
  });
});
