import { describe, expect, it } from 'vitest';
import { leadCard, leadRow } from '../../test/factories';
import type { LeadContact } from '../../lib/contract';
import { bestPhone, collectEmails, collectPhones, defaultSmsRecipient } from './contacts';

const contact = (over: Partial<LeadContact>): LeadContact => ({ id: 1, kind: 'phone', value: null, personName: null, personRole: null, status: 'ok', isPrimary: false, source: 'crm', note: null, updatedAt: '', ...over });

describe('collectPhones', () => {
  it('merges register primary, register extras and CRM phones without duplicates', () => {
    const card = leadCard({ row: leadRow({ tel: '22 000 00 01' }), contacts: [contact({ id: 5, value: '600 111 222', isPrimary: true })] });
    const p = collectPhones(card);
    expect(p.map((x) => x.raw)).toEqual(['600 111 222', '22 000 00 01', '600 000 001']);
    expect(p[0]).toMatchObject({ primary: true, mobile: true, source: 'crm', contactId: 5 });
    expect(p[1]).toMatchObject({ primary: false, mobile: false, source: 'register' });
  });
  it('applies register overrides (marked invalid) and never picks them as best', () => {
    const card = leadCard({ row: leadRow({ tel: '600 000 001' }), rec: { phones: [], d: null }, contacts: [contact({ id: 9, value: '600 000 001', source: 'register', status: 'invalid' })] });
    const p = collectPhones(card);
    expect(p[0]).toMatchObject({ invalid: true, contactId: 9 });
    expect(bestPhone(p)).toBeUndefined();
  });
  it('splits several numbers kept in one register field', () => {
    const card = leadCard({ row: leadRow({ tel: '600 000 101, 600 000 102' }), rec: null });
    const p = collectPhones(card);
    expect(p.map((x) => x.nine)).toEqual(['600000101', '600000102']);
    expect(p.every((x) => x.mobile)).toBe(true);
  });
  it('reports how many accounts share a number', () => {
    const card = leadCard({ phoneOwners: { '220000001': 7 }, row: leadRow({ tel: '22 000 00 01' }), rec: null });
    expect(collectPhones(card)[0]!.sharedWith).toBe(7);
  });
  it('makes the first valid number primary when none is marked', () => {
    expect(collectPhones(leadCard()).filter((x) => x.primary)).toHaveLength(1);
  });
});

describe('collectEmails', () => {
  it('lists register and CRM addresses once', () => {
    const card = leadCard({ row: leadRow({ email: 'A@Example.test' }), rec: { emails: ['a@example.test', 'b@example.test'], d: null }, contacts: [contact({ kind: 'email', value: 'c@example.test', isPrimary: true })] });
    const e = collectEmails(card);
    expect(e.map((x) => x.value)).toEqual(['c@example.test', 'A@Example.test', 'b@example.test']);
    expect(e[0]!.primary).toBe(true);
  });
});

describe('defaultSmsRecipient (RD2-4)', () => {
  it('prefers the entry\'s own mobile over a landline primary and over a call-centre mobile', () => {
    const card = leadCard({
      phoneOwners: { '600000201': 20, '600000202': 4 },
      row: leadRow({ tel: '22 000 00 02, 600 000 201, 600 000 202', mobile: '600000202' }), rec: null,
    });
    expect(defaultSmsRecipient(collectPhones(card), card.row.mobile)?.raw).toBe('600 000 202');
  });
  it('without an own mobile: the first mobile that is not shared by many accounts, else the first mobile', () => {
    const card = leadCard({ phoneOwners: { '600000301': 9 }, row: leadRow({ tel: '22 000 00 03, 600 000 301, 600 000 302', mobile: null }), rec: null });
    expect(defaultSmsRecipient(collectPhones(card), null)?.raw).toBe('600 000 302');
    const only = leadCard({ phoneOwners: { '600000401': 9 }, row: leadRow({ tel: '22 000 00 04, 600 000 401', mobile: null }), rec: null });
    expect(defaultSmsRecipient(collectPhones(only), null)?.raw).toBe('600 000 401');
    const landline = leadCard({ row: leadRow({ tel: '22 000 00 05', mobile: null }), rec: null });
    expect(defaultSmsRecipient(collectPhones(landline), null)?.raw).toBe('22 000 00 05');
  });
});
