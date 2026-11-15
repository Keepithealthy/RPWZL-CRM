import { TEMPLATE_VARIABLES, type LeadCard, type Me, type RefData } from './contract';
import { fmtDate, todayIso } from './format';

export type VarMap = Partial<Record<(typeof TEMPLATE_VARIABLES)[number], string>>;

export interface RenderResult {
  text: string;
  /** variables written in the template that do not exist, e.g. {{imie}} */
  unknown: string[];
  /** known variables that came out empty, e.g. osoba */
  empty: string[];
}

const KNOWN = new Set<string>(TEMPLATE_VARIABLES);

/** Client-side text substitution (SPEC 7.4). Unknown variables stay visible; empty values are reported. */
export function renderTemplate(text: string, vars: VarMap): RenderResult {
  const unknown = new Set<string>();
  const empty = new Set<string>();
  const out = text.replace(/\{\{\s*([a-z_0-9]+)\s*\}\}/gi, (whole, rawName: string) => {
    const name = rawName.toLowerCase();
    if (!KNOWN.has(name)) {
      unknown.add(rawName);
      return whole;
    }
    const v = (vars as Record<string, string | undefined>)[name] ?? '';
    if (!v) empty.add(name);
    return v;
  });
  // an empty variable leaves its separators behind ('adres (, 00-002 Testowo)'): tidy them (E7)
  const tidy = empty.size === 0 ? out : out
    .replace(/\(\s*,\s*/g, '(').replace(/\s*,\s*\)/g, ')').replace(/,(\s*,)+/g, ',').replace(/[ \t]*\([ \t]*\)/g, '');
  return { text: tidy, unknown: [...unknown], empty: [...empty] };
}

export function tidyName(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** Builds the variable values for one lead (or a sample lead) and the signed-in user. */
export function buildVars(card: Pick<LeadCard, 'row' | 'kod' | 'lead' | 'contacts'> & { rec?: LeadCard['rec'] } | null, me: Me, ref: Pick<RefData, 'members'> | null): VarMap {
  const owner = card?.row.ownerId != null ? ref?.members.find((m) => m.id === card.row.ownerId) : undefined;
  const person = card?.contacts.find((c) => c.kind === 'person' && c.isPrimary) ?? card?.contacts.find((c) => c.kind === 'person');
  const name = tidyName(card?.row.name);
  return {
    nazwa: name,
    nazwa_krotka: tidyName(card?.lead?.shortName) || name,
    miasto: card?.row.miasto ?? '',
    ulica: tidyName(card?.rec?.ulica),
    kod: card?.kod ?? '',
    woj: card?.row.woj ?? '',
    nip: card?.row.nip ?? '',
    osoba: person?.personName ?? '',
    opiekun: owner?.displayName ?? me.displayName,
    opiekun_telefon: owner?.phone ?? me.phone ?? '',
    opiekun_email: owner?.email ?? me.email,
    ja: me.displayName,
    ja_telefon: me.phone ?? '',
    ja_email: me.email,
    data: fmtDate(todayIso()),
  };
}

export const VARIABLE_HELP: Record<(typeof TEMPLATE_VARIABLES)[number], string> = {
  nazwa: 'Nazwa podmiotu z rejestru',
  nazwa_krotka: 'Nazwa krótka (jeśli ustawiona), inaczej pełna nazwa',
  miasto: 'Miejscowość',
  ulica: 'Ulica',
  kod: 'Kod pocztowy',
  woj: 'Województwo',
  nip: 'NIP',
  osoba: 'Osoba kontaktowa dodana w CRM',
  opiekun: 'Opiekun leada (jeśli brak: Ty)',
  opiekun_telefon: 'Telefon opiekuna',
  opiekun_email: 'E-mail opiekuna',
  ja: 'Twoje imię i nazwisko',
  ja_telefon: 'Twój telefon',
  ja_email: 'Twój e-mail',
  data: 'Dzisiejsza data',
};

export const SAMPLE_VARS: VarMap = {
  nazwa: 'Przychodnia Przykładowa Sp. z o.o.',
  nazwa_krotka: 'Przychodnia Przykładowa',
  miasto: 'Gdańsk',
  ulica: 'ul. Przykładowa 1',
  kod: '80-001',
  woj: 'pomorskie',
  nip: '0000000000',
  osoba: 'Anna Przykładowa',
  opiekun: 'Jan Handlowiec',
  opiekun_telefon: '600 000 000',
  opiekun_email: 'jan@example.com',
  ja: 'Jan Handlowiec',
  ja_telefon: '600 000 000',
  ja_email: 'jan@example.com',
  data: '01.01.2027',
};
