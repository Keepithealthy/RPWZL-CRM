import { expect, test, type Page } from '@playwright/test';
import { mockBackend, ME } from './mockBackend';

// These tests need the app built with VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY set to any placeholder values
// (the backend is mocked in the browser). See docs/CONTRACT.md "Deviations" for the build line.
// Headless Chrome stops reacting to the page after a real tel:/sms:/mailto: navigation (no OS handler to take it over), so the
// tests record the link instead of following it. The link text is asserted below.
async function stubExternalLinks(page: Page) {
  await page.addInitScript(() => {
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (/^(tel|sms|mailto):/.test(this.href)) { (window as unknown as { __links: string[] }).__links = [...((window as unknown as { __links?: string[] }).__links ?? []), this.href]; return; }
      return orig.call(this);
    };
  });
}

async function signIn(page: Page) {
  await stubExternalLinks(page);
  await page.goto('/');
  if (await page.getByText('Brak konfiguracji').isVisible().catch(() => false)) test.skip(true, 'app built without Supabase placeholders');
  await page.getByLabel('E-mail').fill(ME.email);
  await page.getByLabel('Hasło').fill('placeholder-password');
  await page.getByRole('button', { name: 'Zaloguj' }).click();
  await expect(page.getByRole('link', { name: 'Leady' })).toBeVisible();
}

test('sign in, list with a saved view, open a card and log a call', async ({ page }) => {
  const calls = await mockBackend(page);
  await signIn(page);
  await expect(page.getByText('Dane z rejestru: stan na 14.11.2026')).toBeVisible();

  await page.getByRole('link', { name: 'Leady' }).click();
  await expect(page.getByText('Przychodnia Alfa Sp. z o.o.')).toBeVisible();
  await expect(page.getByText('zniknął z rejestru')).toBeVisible();
  await expect(page.getByText(/Wyniki: 3/)).toBeVisible();

  await page.getByLabel('Widok').selectOption({ label: 'POZ — test' });
  await expect(page.getByText('Widok testowy')).toBeVisible();
  await expect.poll(() => calls.some((c) => c.name === 'leads_search' && (c.args.p_filter as { kind?: string }).kind === 'p')).toBe(true);

  await page.getByText('Przychodnia Alfa Sp. z o.o.').click();
  await expect(page).toHaveURL(/\/lead\/1/);
  await expect(page.getByRole('heading', { name: 'Przychodnia Alfa Sp. z o.o.' })).toBeVisible();
  await expect(page.getByText('Pierwszy import z rejestru')).toBeVisible();

  await page.getByRole('button', { name: 'Zadzwoń' }).first().click();
  expect(await page.evaluate(() => (window as unknown as { __links?: string[] }).__links)).toEqual(['tel:+48600000001']);
  const dialog = page.getByRole('dialog', { name: 'Zapisz wynik kontaktu' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Dzień dobry, mówi Ola Testowa\. Czy rozmawiam z Przychodnia Alfa/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Rozmowa' }).click();
  await dialog.getByRole('button', { name: 'za 3 dni' }).click();
  await dialog.getByRole('button', { name: 'Zapisz', exact: true }).click();
  await expect(page.getByText('Zapisano wynik kontaktu')).toBeVisible();
  const add = calls.find((c) => c.name === 'activity_add')!;
  expect(add.args).toMatchObject({ p_entry_id: 1, p_activity: { type: 'call', outcome: 'rozmowa' } });
});

test('owner sees Import / Eksport / Użytkownicy; the register tab renders text only', async ({ page }) => {
  await mockBackend(page);
  await signIn(page);
  for (const name of ['Import', 'Eksport i kopia', 'Użytkownicy', 'Ustawienia']) await expect(page.getByRole('link', { name })).toBeVisible();
  await page.goto('/lead/1?tab=rejestr');
  await expect(page.getByText('Zakład Testowy')).toBeVisible();
  await expect(page.getByText(/Poradnia Testowa/)).toBeVisible();
});
