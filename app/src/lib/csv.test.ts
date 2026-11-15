import { describe, expect, it } from 'vitest';
import {
  BOM, CSV_COLUMNS, CUSTOMERIO_HEADERS, buildCustomerioCsv, buildGenericCsv, csvCell, customerioEmail, customerioEmailQuality, customerioWebsite, dedupeRows, exportFileName,
  guardFormula, prepareCustomerio, unixSeconds,
} from './csv';
import { exportRow } from '../test/factories';

const parse = (csv: string) => csv.trim().split('\r\n');

describe('csv primitives', () => {
  it('quotes cells with separator, quote or newline', () => {
    expect(csvCell('a;b', ';')).toBe('"a;b"');
    expect(csvCell('he said "hi"', ',')).toBe('"he said ""hi"""');
    expect(csvCell('l1\nl2', ';')).toBe('"l1\nl2"');
    expect(csvCell('plain', ';')).toBe('plain');
  });
  it('guards spreadsheet formulas', () => {
    for (const s of ['=1+1', '+48600', '-5', '@SUM(A1)', '\tx', '\rx']) expect(guardFormula(s)).toBe(`'${s}`);
    expect(guardFormula('Kowalski')).toBe('Kowalski');
  });
  it('builds safe file names', () => {
    expect(exportFileName('POZ — podstawowa opieka zdrowotna', 'csv', '2026-11-15')).toBe('rpwzl-poz-podstawowa-opieka-zdrowotna-2026-11-15.csv');
    expect(exportFileName('Łódź & spółka', 'csv', '2026-11-15')).toBe('rpwzl-lodz-spolka-2026-11-15.csv');
  });
  it('shortens a long label before adding the suffix (RDV-5)', () => {
    expect(exportFileName('POZ — podstawowa opieka zdrowotna', 'csv', '2026-11-15', 'customerio')).toBe('rpwzl-poz-podstawowa-opieka-zdrowotna-customerio-2026-11-15.csv');
    expect(exportFileName('Bardzo długa nazwa widoku zapisanego przez zespół sprzedaży', 'csv', '2026-11-15', 'customerio'))
      .toBe('rpwzl-bardzo-dluga-nazwa-widoku-zapisanego-customerio-2026-11-15.csv');
  });
});

describe('generic CSV', () => {
  it('writes Polish headers, the first five always, and guards cells', () => {
    const rows = dedupeRows([exportRow({ name: '=HYPERLINK("x")', miasto: 'Gdańsk' })], 'none').rows;
    const lines = parse(buildGenericCsv(rows, { separator: ';', bom: false, optionalColumns: ['woj'] }));
    expect(lines[0]).toBe('Nazwa;E-mail;Telefon;NIP;Miejscowość;Województwo');
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(lines[1]).toContain('Gdańsk;testowe');
  });
  it('has every documented column', () => {
    expect(CSV_COLUMNS.map((c) => c.header)).toEqual(expect.arrayContaining(['Telefon komórkowy', 'Klucz rejestru', 'ID CRM', 'Nie kontaktować', 'Inne e-maile']));
    expect(BOM).toBe('﻿');
  });
  it('dedupes by NIP, keeps the best contact and merges the others', () => {
    const a = exportRow({ id: 5, keyHash: 'a', nip: '5260250995', tel: null, email: null, www: null, emails: [], phones: [] });
    const b = exportRow({ id: 9, keyHash: 'b', nip: '5260250995', tel: '600 000 002', email: 'x@example.test', emails: ['x@example.test'], phones: ['600 000 002'] });
    const c = exportRow({ id: 2, keyHash: 'c', nip: '0000000000', email: 'c@example.test' });
    const d = exportRow({ id: 3, keyHash: 'd', nip: '0000000000', email: 'd@example.test' });
    const out = dedupeRows([a, b, c, d], 'nip');
    expect(out.merged).toBe(1);
    expect(out.rows.map((r) => r.row.id)).toEqual([9, 2, 3]); // placeholder NIPs are never merged
    const winner = out.rows[0]!;
    expect(winner.extra.otherEmails).toEqual([]);
  });
  it('dedupes by e-mail ignoring case', () => {
    const out = dedupeRows([exportRow({ id: 1, email: 'A@Example.test' }), exportRow({ id: 2, email: 'a@example.test', tel: null })], 'email');
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.row.id).toBe(1);
  });
});

describe('Customer.io CSV', () => {
  it('uses fixed snake_case headers, id/email first, no BOM, unix timestamps', () => {
    const prep = prepareCustomerio([exportRow({ nip: '526-025-09-95' })], { identifier: 'email', includePhoneColumn: false });
    const csv = buildCustomerioCsv(prep.rows, { identifier: 'email', includePhoneColumn: false });
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    const [header, line] = parse(csv) as [string, string];
    expect(header.split(',')).toEqual([...CUSTOMERIO_HEADERS]);
    const cells = Object.fromEntries(header.split(',').map((h, i) => [h, line.split(',')[i]]));
    expect(cells.id).toBe('rpwdl-00000000000000a1');
    expect(cells.email).toBe('biuro@example.test');
    expect(cells.created_at).toBe(String(Date.parse('2026-11-14T10:00:00Z') / 1000));
    expect(cells.nip).toBe('5260250995');
    expect(cells.sms_phone).toBe('+48600000001');
    expect(cells.register_entry_date).toBe(String(Date.parse('2024-01-15T00:00:00Z') / 1000));
    expect(cells.in_register).toBe('true');
    const gone = parse(buildCustomerioCsv(prepareCustomerio([exportRow({ inRegister: false })], { identifier: 'email', includePhoneColumn: false }).rows, { identifier: 'email', includePhoneColumn: false })) as [string, string];
    expect(gone[1].split(',')[gone[0].split(',').indexOf('in_register')]).toBe('false');
    expect(header).not.toContain('unsubscribed');
  });
  it('skips rows without e-mail and merges duplicates by quality, podmiot first, lowest id', () => {
    const rows = [
      exportRow({ id: 1, keyHash: '01', email: null }),
      exportRow({ id: 2, keyHash: '02', email: 'Same@example.test', qEmail: 40, kind: 'r' }),
      exportRow({ id: 3, keyHash: '03', email: 'same@example.test', qEmail: 90, kind: 'r' }),
      exportRow({ id: 4, keyHash: '04', email: 'other@example.test', qEmail: 50, kind: 'p' }),
      exportRow({ id: 5, keyHash: '05', email: 'other@example.test', qEmail: 50, kind: 'r' }),
    ];
    const p = prepareCustomerio(rows, { identifier: 'email', includePhoneColumn: false });
    expect(p.skippedNoEmail).toBe(1);
    expect(p.skippedDuplicates).toBe(2);
    expect(p.rows.map((r) => r.row.id)).toEqual([3, 4]);
    expect(p.rows[0]!.leadIds).toEqual(['rpwdl-02']);
  });
  it('email_quality describes the exported address, not the entry\'s best one (RD3-1)', () => {
    const typoFirst = exportRow({ email: 'x@gmail.pl', emails: ['x@gmail.pl', 'y@firma.example.test'], qEmail: 100 });
    expect(customerioEmail(typoFirst)).toBe('x@gmail.pl');
    expect(customerioEmailQuality(typoFirst)).toBeLessThanOrEqual(10);
    const p = prepareCustomerio([typoFirst], { identifier: 'email', includePhoneColumn: false });
    const [header, line] = parse(buildCustomerioCsv(p.rows, { identifier: 'email', includePhoneColumn: false })) as [string, string];
    expect(Number(line.split(',')[header.split(',').indexOf('email_quality')])).toBeLessThanOrEqual(10);
    // a good exported address keeps the stored score
    expect(customerioEmailQuality(exportRow({ email: 'y@firma.example.test', emails: ['y@firma.example.test'], qEmail: 70 }))).toBe(70);
    // the winner of an e-mail group is chosen by the quality of the shared address
    const rows = [
      exportRow({ id: 1, keyHash: '01', kind: 'r', email: 'x@gmail.pl', emails: ['x@gmail.pl'], qEmail: 90 }),
      exportRow({ id: 2, keyHash: '02', kind: 'p', email: 'x@gmail.pl', emails: ['x@gmail.pl'], qEmail: 50 }),
    ];
    expect(prepareCustomerio(rows, { identifier: 'email', includePhoneColumn: false }).rows[0]!.row.id).toBe(2);
  });
  it('keeps every row in id mode and can add a phone column', () => {
    const rows = [exportRow({ id: 1, email: null }), exportRow({ id: 2 })];
    const p = prepareCustomerio(rows, { identifier: 'id', includePhoneColumn: true });
    expect(p.rows).toHaveLength(2);
    const header = parse(buildCustomerioCsv(p.rows, { identifier: 'id', includePhoneColumn: true }))[0]!.split(',');
    expect(header[2]).toBe('phone');
    expect(header).toContain('sms_phone');
  });
  it('writes the normalised host as website, empty for invalid or social values (RDV-1)', () => {
    expect(customerioWebsite('https://WWW.Przychodnia-Testowa.example.test/kontakt?x=1')).toBe('przychodnia-testowa.example.test');
    expect(customerioWebsite('www.testowa.example.test')).toBe('testowa.example.test');
    expect(customerioWebsite('http://www.facebook.com/testowa')).toBe('');
    expect(customerioWebsite('brak')).toBe('');
    expect(customerioWebsite('ul. Próbna 1')).toBe('');
    expect(customerioWebsite('www.a.example.test, www.b.example.test')).toBe('a.example.test');
    expect(customerioWebsite(null)).toBe('');
    const p = prepareCustomerio([exportRow({ www: 'HTTP://www.Testowa.example.test/' })], { identifier: 'email', includePhoneColumn: false });
    const [header, line] = parse(buildCustomerioCsv(p.rows, { identifier: 'email', includePhoneColumn: false })) as [string, string];
    expect(line.split(',')[header.split(',').indexOf('website')]).toBe('testowa.example.test');
  });
  it('never writes an invalid multi-address e-mail (RDV-2)', () => {
    expect(customerioEmail({ email: 'Jeden@Example.test, dwa@example.test', emails: ['jeden@example.test', 'dwa@example.test'] })).toBe('jeden@example.test');
    expect(customerioEmail({ email: 'zly adres; Drugi@Example.test', emails: [] })).toBe('drugi@example.test');
    expect(customerioEmail({ email: 'zly@@adres', emails: ['zly@@adres', 'Inny@Example.test'] })).toBe('inny@example.test');
    expect(customerioEmail({ email: 'zly@@adres', emails: [] })).toBe('');
    expect(customerioEmail({ email: null, emails: ['a@example.test'] })).toBe('');
    const rows = [
      exportRow({ id: 1, keyHash: '01', email: 'x@example.test; y@example.test', emails: ['x@example.test', 'y@example.test'] }),
      exportRow({ id: 2, keyHash: '02', email: 'zly@@adres', emails: ['zly@@adres'] }),
    ];
    const p = prepareCustomerio(rows, { identifier: 'email', includePhoneColumn: false });
    expect(p.skippedNoEmail).toBe(1);
    const [header, line] = parse(buildCustomerioCsv(p.rows, { identifier: 'email', includePhoneColumn: false })) as [string, string];
    expect(line.split(',')[header.split(',').indexOf('email')]).toBe('x@example.test');
  });
  it('leaves dates before 1970 empty (RDV-6)', () => {
    expect(unixSeconds('1956-01-01')).toBe('');
    expect(unixSeconds('1970-01-01')).toBe('0');
    expect(unixSeconds('2024-01-15')).toBe(String(Date.parse('2024-01-15T00:00:00Z') / 1000));
    expect(unixSeconds(null)).toBe('');
  });
  it('does not apply the formula guard (it would alter values)', () => {
    const p = prepareCustomerio([exportRow({ name: '=X' })], { identifier: 'email', includePhoneColumn: false });
    expect(buildCustomerioCsv(p.rows, { identifier: 'email', includePhoneColumn: false })).toContain(',=X,');
  });
});
