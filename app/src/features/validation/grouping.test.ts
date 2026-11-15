import { describe, expect, it } from 'vitest';
import type { LeadRow, ProposalSummary } from '../../lib/contract';
import {
  accountCheckReason, combinedConfidence, confidenceTone, defaultNetworkName, describeProposal, entriesByAccount, groupProposals, minorityEntries,
  splitEntries,
} from './grouping';

const prop = (id: number, kind: ProposalSummary['kind'], conf: number, members: string[], groupKey = 'g1', extra: Partial<ProposalSummary> = {}): ProposalSummary => ({
  id, kind, matchValue: 'v' + id, confidence: conf, groupKey, status: 0, members, newMembers: [], decidedBy: null, decidedAt: null, note: null, networkId: null, ...extra,
});
const row = (id: number, o: Partial<LeadRow>): LeadRow => ({ id, kind: 'p', entityType: 1, accountKey: 'n:1', accountSize: 1, name: `Wpis ${id}`, ...o }) as LeadRow;

describe('grouping', () => {
  it('combined confidence is max + 5 per extra reason, capped at 99', () => {
    expect(combinedConfidence([85])).toBe(85);
    expect(combinedConfidence([85, 70])).toBe(90);
    expect(combinedConfidence([85, 80, 70])).toBe(95);
    expect(combinedConfidence([98, 90, 80])).toBe(99);
    expect(combinedConfidence([])).toBe(0);
  });

  it('groups network proposals with identical member sets and keeps others apart', () => {
    const list = [
      prop(1, 'email', 85, ['a', 'b'], 'ga'), prop(2, 'www', 80, ['a', 'b'], 'ga'),
      prop(3, 'domain', 55, ['c', 'd', 'e'], 'gc'),
      prop(4, 'phone', 50, ['f', 'g'], 'gf', { newMembers: ['g'] }),
    ];
    const g = groupProposals(list, true);
    expect(g.map((x) => x.proposals.length)).toEqual([2, 1, 1]);
    expect(g[0]?.confidence).toBe(90);
    expect(g[0]?.kinds).toEqual(['email', 'www']);
    expect(g[2]?.newMembers).toEqual(['g']);
    // account proposals are never grouped
    const acc = groupProposals([prop(5, 'account_check', 60, ['a'], 'x'), prop(6, 'person', 90, ['a'], 'x')], false);
    expect(acc).toHaveLength(2);
    expect(acc[0]?.confidence).toBe(90);
  });

  it('describes evidence in Polish', () => {
    expect(describeProposal('email', 'a@b.pl')).toBe('Ten sam adres e-mail: a@b.pl');
    expect(describeProposal('domain', 'firma.pl')).toBe('Ta sama domena e-mail: @firma.pl');
    expect(describeProposal('phone', '225550001')).toBe('Ten sam numer telefonu: 225 550 001');
    expect(describeProposal('person', 'npwz:123')).toContain('nr 123');
    expect(describeProposal('reg_duplicate', 'Rpm|Wojewoda|DUP/1')).toContain('Wojewoda / DUP/1');
    expect(describeProposal('account_check', 'n:1234567890')).toContain('NIP 1234567890');
  });

  it('confidence tone', () => {
    expect(confidenceTone(90)).toBe('green');
    expect(confidenceTone(60)).toBe('yellow');
    expect(confidenceTone(50)).toBe('gray');
  });

  it('minorityEntries splits the smaller class; practices on a tie; nothing for one class', () => {
    const company = row(1, { entityType: 1 });
    const p1 = row(2, { entityType: 4, kind: 'r' }), p2 = row(3, { entityType: 5, kind: 'r' });
    expect(minorityEntries([company, p1, p2]).map((e) => e.id)).toEqual([1]);
    expect(minorityEntries([company, p1]).map((e) => e.id)).toEqual([2]);
    expect(minorityEntries([p1, p2])).toEqual([]);
    expect(minorityEntries([company, row(9, { entityType: 3 })])).toEqual([]);
  });

  it('default network name is the name of the largest member account', () => {
    const entries = [row(1, { accountKey: 'a', name: 'Mała' }), row(2, { accountKey: 'b', name: 'Duża' }), row(3, { accountKey: 'b', name: 'Duża praktyka', kind: 'r' })];
    expect(defaultNetworkName(entries, ['a', 'b'])).toBe('Duża');
    expect(defaultNetworkName([], ['a'])).toBe('Nowa sieć');
  });

  it('entriesByAccount follows the member order, podmioty before practices', () => {
    const e = [row(1, { accountKey: 'b', kind: 'r', name: 'Zet' }), row(2, { accountKey: 'a' }), row(3, { accountKey: 'b', name: 'Be' })];
    const g = entriesByAccount(e, ['b', 'a']);
    expect(g.map((x) => x.key)).toEqual(['b', 'a']);
    expect(g[0]?.entries.map((x) => x.id)).toEqual([3, 1]);
  });
});

describe('round 3: account check wording and the database split list (VAL-R5-1)', () => {
  it('names the kind of conflict from the entries', () => {
    expect(accountCheckReason([row(1, { entityType: 1 }), row(2, { entityType: 4 })])).toBe('ten sam NIP ma firma lub podmiot publiczny i praktyka');
    expect(accountCheckReason([row(1, { entityType: 2 }), row(2, { entityType: 4 })])).toBe('ten sam NIP ma JDG i praktyka innej osoby');
    expect(accountCheckReason([row(1, { entityType: 4 }), row(2, { entityType: 4 })])).toBe('ten sam NIP mają praktyki różnych osób');
    expect(accountCheckReason([])).toBeNull();
  });
  it('uses the detail\'s detachIds when present (also for a JDG account), else the company / practice rule', () => {
    const jdg = [row(1, { entityType: 2 }), row(2, { entityType: 4 }), row(3, { entityType: 4 })];
    expect(splitEntries(jdg, [3]).map((e) => e.id)).toEqual([3]);
    expect(splitEntries(jdg, [])).toEqual([]);
    expect(splitEntries([row(1, { entityType: 1 }), row(2, { entityType: 4 })], undefined).map((e) => e.id)).toEqual([2]);
  });
});
