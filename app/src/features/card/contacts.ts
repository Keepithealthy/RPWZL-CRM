import type { LeadCard, LeadContact } from '../../lib/contract';
import { isMobileNine, nationalNumber } from '../../lib/links';
import { MOBILE_SHARED_OWNERS } from '../validation/rules';

export interface PhoneItem {
  raw: string;
  nine: string | null;
  mobile: boolean;
  primary: boolean;
  invalid: boolean;
  source: 'crm' | 'register';
  contactId: number | null;
  sharedWith: number;
  note: string | null;
}
export interface EmailItem { value: string; primary: boolean; invalid: boolean; source: 'crm' | 'register'; contactId: number | null }

const norm = (s: string) => s.trim().toLowerCase();
/** Several numbers in one register field ("600 000 101, 600 000 102"); same separators as the validation's parsePhone. */
const PHONE_SPLIT_RE = /[,;|/\n\r]|\s+(?:lub|albo|oraz|i)\s+/;
const splitPhones = (raw: string): string[] => raw.split(PHONE_SPLIT_RE).map((x) => x.trim()).filter(Boolean);

function override(card: LeadCard, kind: LeadContact['kind'], value: string): LeadContact | undefined {
  return card.contacts.find((c) => c.kind === kind && c.source === 'register' && c.value !== null && norm(c.value) === norm(value));
}

/** All phone strings of the lead: CRM-added, register primary and register extras, with CRM overrides applied. */
export function collectPhones(card: LeadCard): PhoneItem[] {
  const seen = new Set<string>();
  const items: PhoneItem[] = [];
  const add = (raw: string | null | undefined, source: 'crm' | 'register', crm?: LeadContact) => {
    if (!raw || !raw.trim()) return;
    const key = norm(raw);
    if (seen.has(key)) return;
    seen.add(key);
    const ov = crm ?? override(card, 'phone', raw);
    const nine = nationalNumber(raw);
    items.push({
      raw: raw.trim(), nine, mobile: isMobileNine(nine) || (nine !== null && nine === card.row.mobile),
      primary: Boolean(ov?.isPrimary), invalid: ov?.status === 'invalid', source, contactId: ov?.id ?? null,
      sharedWith: nine ? (card.phoneOwners[nine] ?? 0) : 0, note: ov?.note ?? null,
    });
  };
  for (const c of card.contacts) if (c.kind === 'phone' && c.source === 'crm') add(c.value, 'crm', c);
  // a register field may hold several numbers: each one gets its own entry so that the number picker can offer them
  for (const t of card.row.tel ? splitPhones(card.row.tel) : []) add(t, 'register');
  for (const p of card.rec?.phones ?? []) for (const t of splitPhones(p)) add(t, 'register');
  // the register primary stays primary unless a CRM primary exists
  if (!items.some((i) => i.primary)) {
    const first = items.find((i) => !i.invalid);
    if (first) first.primary = true;
  }
  return items;
}

/**
 * The number an SMS goes to by default (RD2-4): a mobile the team marked primary in the CRM, else the entry's own `mobile` (a
 * mobile used by fewer than MOBILE_SHARED_OWNERS accounts), else the first mobile that is not a call-centre number, else the
 * first mobile, else the first number.
 */
export function defaultSmsRecipient(phones: readonly PhoneItem[], rowMobile: string | null | undefined): PhoneItem | undefined {
  return phones.find((p) => p.source === 'crm' && p.primary && p.mobile)
    ?? (rowMobile ? phones.find((p) => p.nine === rowMobile) : undefined)
    ?? phones.find((p) => p.mobile && p.sharedWith < MOBILE_SHARED_OWNERS)
    ?? phones.find((p) => p.mobile)
    ?? phones[0];
}

export function collectEmails(card: LeadCard): EmailItem[] {
  const seen = new Set<string>();
  const items: EmailItem[] = [];
  const add = (v: string | null | undefined, source: 'crm' | 'register', crm?: LeadContact) => {
    if (!v || !v.trim()) return;
    const key = norm(v);
    if (seen.has(key)) return;
    seen.add(key);
    const ov = crm ?? override(card, 'email', v);
    items.push({ value: v.trim(), primary: Boolean(ov?.isPrimary), invalid: ov?.status === 'invalid', source, contactId: ov?.id ?? null });
  };
  for (const c of card.contacts) if (c.kind === 'email' && c.source === 'crm') add(c.value, 'crm', c);
  add(card.row.email, 'register');
  for (const e of card.rec?.emails ?? []) add(e, 'register');
  if (!items.some((i) => i.primary)) {
    const first = items.find((i) => !i.invalid);
    if (first) first.primary = true;
  }
  return items;
}

/** The phone a quick "Zadzwoń" should use: primary, else first valid. */
export function bestPhone(items: PhoneItem[]): PhoneItem | undefined {
  return items.find((i) => i.primary && !i.invalid) ?? items.find((i) => !i.invalid);
}
