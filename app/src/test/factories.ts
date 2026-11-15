import type { ExportRow, LeadCard, LeadRow, Me, RefData } from '../lib/contract';

/** Synthetic data only: no real register records anywhere in tests. */
export function leadRow(over: Partial<LeadRow> = {}): LeadRow {
  return {
    id: 1, kind: 'p', src: 'Rpm', name: 'Przychodnia Testowa Sp. z o.o.', nip: '0000000001', email: 'rejestracja@example.test', tel: '22 000 00 01',
    mobile: null, www: 'example.test', miasto: 'Testowo', woj: 'testowe', wpis: '2024-01-15', stan: '2025-06-01', nz: 1, nk: 3, spec1: 2, entityType: 1,
    inRegister: true, qEmail: 80, qPhone: 60, qflags: 0, accountKey: 'n:0000000001', accountSize: 1, statusId: 1, ownerId: null, tags: [], validation: 0,
    validationIsDerived: true, dnc: false, nextStepAt: null, nextStepNote: null, lastContactAt: null, networkId: null, version: 0, ...over,
  };
}

export function exportRow(over: Partial<ExportRow> = {}): ExportRow {
  return {
    id: 1, regKey: '0|Org|1|1', keyHash: '00000000000000a1', kind: 'p', src: 'Rpm', name: 'Przychodnia Testowa', shortName: null, nip: '5260250995',
    email: 'biuro@example.test', emails: ['biuro@example.test'], tel: '22 000 00 01', mobile: '600000001', phones: ['22 000 00 01'], www: 'example.test',
    miasto: 'Testowo', woj: 'testowe', ulica: 'ul. Próbna 1', kod: '00-001', forma: 'spółka z o.o.', formType: 'komercyjna', entityType: 1, status: 'Nowy',
    owner: null, tags: [], validation: 0, nextStepAt: null, lastContactAt: null, wpis: '2024-01-15', stan: '2025-06-01', spec1: 2, nz: 1, nk: 3, qEmail: 80,
    dnc: false, inRegister: true, firstImportedAt: '2026-11-14T10:00:00Z', ...over,
  };
}

export const me: Me = { memberId: 1, email: 'owner@example.test', displayName: 'Ola Właścicielka', role: 'owner', phone: '600 000 000' };

export function refData(over: Partial<RefData> = {}): RefData {
  return {
    me,
    statuses: [
      { id: 1, name: 'Nowy', color: '#888888', sort: 1, stage: 'open', isDefault: true, active: true },
      { id: 2, name: 'Do kontaktu', color: '#0b5cad', sort: 2, stage: 'open', isDefault: false, active: true },
      { id: 8, name: 'Nie teraz', color: '#aa8800', sort: 8, stage: 'paused', isDefault: false, active: true },
    ],
    tags: [{ id: 1, name: 'VIP', color: '#000000' }],
    members: [{ id: 1, displayName: 'Ola Właścicielka', role: 'owner', active: true, phone: '600 000 000', email: 'owner@example.test' }],
    views: [], lists: [], lastImport: { id: 1, reportDate: '2026-11-14', finishedAt: '2026-11-14T12:00:00Z' },
    settings: { staleDays: 35, valMinConfidence: 50, smsDiacritics: 'keep' }, ...over,
  };
}

export function leadCard(over: Partial<LeadCard> = {}): LeadCard {
  return {
    row: leadRow(), regKey: '0|Org|1|1', ks: '000000000001', org: 'Organ Testowy', kod: '00-001', facets: { 'p.status': ['aktywny'] },
    rec: { emails: ['rejestracja@example.test'], phones: ['600 000 001'], ulica: 'ul. Próbna 1', rodzaje: ['Ambulatoryjne świadczenia zdrowotne'], dz: ['Medycyna rodzinna'], fn: ['HC.1.3.3.'], d: null },
    lead: null, contacts: [], account: [], network: null, proposals: [], lists: [], phoneOwners: {}, firstRun: { id: 1, reportDate: '2026-11-14' }, lastChange: null, ...over,
  };
}
