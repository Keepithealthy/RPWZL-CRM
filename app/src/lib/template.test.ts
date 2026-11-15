import { describe, expect, it } from 'vitest';
import { buildVars, renderTemplate } from './template';
import { leadCard, me, refData } from '../test/factories';

describe('renderTemplate', () => {
  it('substitutes known variables', () => {
    const r = renderTemplate('Dzień dobry, {{nazwa}} w {{ miasto }}!', { nazwa: 'Klinika', miasto: 'Gdańsk' });
    expect(r.text).toBe('Dzień dobry, Klinika w Gdańsk!');
    expect(r.unknown).toEqual([]);
    expect(r.empty).toEqual([]);
  });
  it('keeps unknown variables visible and lists them', () => {
    const r = renderTemplate('Cześć {{imie}}', {});
    expect(r.text).toBe('Cześć {{imie}}');
    expect(r.unknown).toEqual(['imie']);
  });
  it('lists known but empty variables', () => {
    const r = renderTemplate('{{osoba}} / {{osoba}} / {{nazwa}}', { nazwa: 'X' });
    expect(r.empty).toEqual(['osoba']);
    expect(r.text).toBe(' /  / X');
  });
});

describe('renderTemplate: empty address parts (E7)', () => {
  it('drops the separators an empty variable leaves behind', () => {
    expect(renderTemplate('adres ({{ulica}}, {{kod}} {{miasto}}), telefon', { kod: '00-002', miasto: 'Testowo' }).text).toBe('adres (00-002 Testowo), telefon');
    expect(renderTemplate('adres ({{ulica}}, {{kod}} {{miasto}}), telefon', {}).text).toBe('adres, telefon');
    expect(renderTemplate('adres ({{ulica}}, {{kod}} {{miasto}})', { ulica: 'ul. Testowa 1', kod: '00-002', miasto: 'Testowo' }).text).toBe('adres (ul. Testowa 1, 00-002 Testowo)');
  });
});

describe('buildVars', () => {
  it('uses the short name, the owner and the user', () => {
    const card = leadCard({ lead: { shortName: 'Przychodnia T.', dncReason: null, dncAt: null, validationNote: null, checklist: null, validatedAt: null, validatedBy: null, regChangedAfterValidation: false } });
    card.row.ownerId = 1;
    const v = buildVars(card, me, refData());
    expect(v.nazwa_krotka).toBe('Przychodnia T.');
    expect(v.opiekun).toBe('Ola Właścicielka');
    expect(v.ja_email).toBe('owner@example.test');
    expect(v.data).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
  });
  it('falls back to the current user when the lead has no owner', () => {
    expect(buildVars(leadCard(), me, refData()).opiekun_telefon).toBe('600 000 000');
  });
});
