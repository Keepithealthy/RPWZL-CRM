/**
 * Pure helpers of the "Walidacja" screen: grouping proposals with identical member sets, describing the evidence in
 * Polish, and deciding which entries a "to różne podmioty" answer splits out of an account (SPEC 4.7, 6.6).
 */
import { ENTITY_TYPE, PROPOSAL_KIND_PL, type EntityType, type LeadRow, type ProposalKind, type ProposalSummary } from '../../lib/contract';

/** Combined confidence of proposals with identical members: min(99, max + 5 x (count - 1)) (SPEC 6.6). */
export function combinedConfidence(confidences: readonly number[]): number {
  if (confidences.length === 0) return 0;
  return Math.min(99, Math.max(...confidences) + 5 * (confidences.length - 1));
}

export interface ProposalGroup {
  /** `groupKey` (or `id:<n>` for proposals that are never grouped) */
  key: string;
  proposals: ProposalSummary[];
  confidence: number;
  members: string[];
  newMembers: string[];
  kinds: ProposalKind[];
}

/** Proposals of the account queue are never grouped; network proposals with equal `groupKey` become one card. */
export function groupProposals(list: readonly ProposalSummary[], groupNetworks: boolean): ProposalGroup[] {
  const groups = new Map<string, ProposalGroup>();
  for (const p of list) {
    const key = groupNetworks ? `g:${p.groupKey}:${p.status}` : `id:${p.id}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, proposals: [], confidence: 0, members: p.members, newMembers: [], kinds: [] };
      groups.set(key, g);
    }
    g.proposals.push(p);
    for (const m of p.newMembers) if (!g.newMembers.includes(m)) g.newMembers.push(m);
    if (!g.kinds.includes(p.kind)) g.kinds.push(p.kind);
  }
  const out = [...groups.values()];
  for (const g of out) g.confidence = combinedConfidence(g.proposals.map((p) => p.confidence));
  return out.sort((a, b) => b.confidence - a.confidence || b.members.length - a.members.length || (a.key < b.key ? -1 : 1));
}

/** One line of evidence for a proposal ("Ten sam adres e-mail: x@y.pl"). */
export function describeProposal(kind: ProposalKind, matchValue: string): string {
  const label = PROPOSAL_KIND_PL[kind].split(' (')[0] as string;
  switch (kind) {
    case 'email': return `${label}: ${matchValue}`;
    case 'domain': return `${label}: @${matchValue}`;
    case 'www': return `${label}: ${matchValue}`;
    case 'phone': return `${label}: ${matchValue.replace(/^(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3')}`;
    case 'person': return `${label}: nr ${matchValue.replace(/^npwz:(?:[a-z]+:)?/, '')}`;
    case 'partner': return matchValue.startsWith('npwz:') ? `${label}: numer prawa wykonywania zawodu wspólnika jest numerem innego wpisu` : `${label}: NIP wspólnika jest NIP-em innego wpisu`;
    case 'reg_duplicate': return `${label}: ten sam numer księgi (${matchValue.split('|').slice(1).join(' / ')})`;
    case 'account_check': return `${label}: NIP ${matchValue.replace(/^n:/, '')}`;
    default: return `${label}: ${matchValue}`;
  }
}

export type ConfidenceTone = 'green' | 'yellow' | 'gray';
export function confidenceTone(c: number): ConfidenceTone {
  return c >= 80 ? 'green' : c >= 60 ? 'yellow' : 'gray';
}

const COMPANY: EntityType[] = [ENTITY_TYPE.PODMIOT_PRAWNY, ENTITY_TYPE.PUBLICZNY];
const PRACTICE: EntityType[] = [ENTITY_TYPE.PRAKTYKA_IND, ENTITY_TYPE.PRAKTYKA_GRUP];

/**
 * "To różne podmioty" on an `account_check` card: the entries of the smaller class (companies / public entities versus
 * practices) get their own accounts. On a tie the practices are split out. Entries of the JDG type stay where they are.
 */
export function minorityEntries(entries: readonly LeadRow[]): LeadRow[] {
  const companies = entries.filter((e) => COMPANY.includes(e.entityType));
  const practices = entries.filter((e) => PRACTICE.includes(e.entityType));
  if (companies.length === 0 || practices.length === 0) return [];
  return companies.length < practices.length ? companies : practices;
}

/**
 * Why an `account_check` account needs a look, from its entries (VAL-R5-1): a company / public body next to practices, a JDG
 * next to somebody else's practice, or practices of different people.
 */
export function accountCheckReason(entries: readonly LeadRow[]): string | null {
  if (entries.length === 0) return null;
  if (entries.some((e) => COMPANY.includes(e.entityType)) && entries.some((e) => PRACTICE.includes(e.entityType))) {
    return 'ten sam NIP ma firma lub podmiot publiczny i praktyka';
  }
  if (entries.some((e) => e.entityType === ENTITY_TYPE.JDG)) return 'ten sam NIP ma JDG i praktyka innej osoby';
  return 'ten sam NIP mają praktyki różnych osób';
}

/** The entries a reject detaches: the database's list when the detail carries it (VAL-R5-1), else the company / practice rule. */
export function splitEntries(entries: readonly LeadRow[], detachIds: readonly number[] | undefined): LeadRow[] {
  return detachIds ? entries.filter((e) => detachIds.includes(e.id)) : minorityEntries(entries);
}

/** Default network name: the name of the largest member account (most entries), else of the first entry. */
export function defaultNetworkName(entries: readonly LeadRow[], memberKeys: readonly string[]): string {
  let best: LeadRow | null = null;
  let bestSize = -1;
  for (const key of memberKeys) {
    const inAccount = entries.filter((e) => e.accountKey === key);
    const primary = inAccount.find((e) => e.accountSize >= 1 && e.name) ?? inAccount[0];
    if (primary && inAccount.length > bestSize) {
      best = primary;
      bestSize = inAccount.length;
    }
  }
  return (best ?? entries[0])?.name?.trim() || 'Nowa sieć';
}

/** Entries grouped by account key, in member order (accounts of the proposal first, entries inside by name). */
export function entriesByAccount(entries: readonly LeadRow[], memberKeys: readonly string[]): Array<{ key: string; entries: LeadRow[] }> {
  return memberKeys.map((key) => ({
    key,
    entries: entries
      .filter((e) => e.accountKey === key)
      .sort((a, b) => (a.kind === b.kind ? (a.name ?? '').localeCompare(b.name ?? '', 'pl') : a.kind === 'p' ? -1 : 1)),
  }));
}
