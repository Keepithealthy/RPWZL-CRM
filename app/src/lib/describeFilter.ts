import type { FacetKey, LeadFilter, RefData } from './contract';

export const FACET_TITLE: Record<FacetKey, string> = {
  'p.status': 'Status podmiotu', 'p.rodzaje': 'Rodzaj działalności leczniczej', 'p.grp': 'Grupa specjalności komórek',
  'p.spec': 'Specjalności komórek', 'p.dz': 'Dziedzina', 'p.fn': 'Funkcja ochrony zdrowia', 'p.forma': 'Forma organizacyjno-prawna',
  'p.formType': 'Typ formy', 'p.woj': 'Województwo (podmioty)',
  'r.src': 'Źródło', 'r.grupaPraktyk': 'Grupa praktyk', 'r.gz': 'Grupa zawodowa', 'r.typ': 'Typ praktyki', 'r.rodzaj': 'Rodzaj praktyki',
  'r.rd': 'Rodzaj działalności', 'r.spec': 'Specjalizacja', 'r.zakres': 'Zakres świadczeń', 'r.forma': 'Forma', 'r.organ': 'Organ rejestrowy',
  'r.status': 'Status wpisu', 'r.woj': 'Województwo (praktyki)',
};

/** Polish labels for facet values that are internal codes. */
export const VALUE_LABEL: Partial<Record<FacetKey, Record<string, string>>> = {
  'p.formType': { komercyjna: 'Komercyjna (prywatna)', publiczna: 'Publiczna', inna: 'Inna' },
  'r.status': { active: 'Aktywny', suspended: 'Zawieszony', inactive: 'Nieaktywny' },
  'p.grp': { '?': 'Nieprzypisane / nieprawidłowy kod' },
};

export const NEXT_STEP_PL = { overdue: 'zaległy', today: 'na dziś', week: 'w ciągu 7 dni', none: 'brak', any: 'ustawiony', due: 'na dziś lub zaległy' } as const;
export const LAST_CONTACT_PL = { never: 'nigdy', '7d': 'do 7 dni temu', '30d': 'do 30 dni temu', '90d': 'do 90 dni temu', older90: 'ponad 90 dni temu' } as const;

/** Text description of the active filters ("describeState" of the offline tool). */
export function describeFilter(f: LeadFilter, ref: Pick<RefData, 'statuses' | 'members' | 'tags' | 'lists'> | null, labelOf?: (k: FacetKey, v: string) => string): string[] {
  const out: string[] = [];
  if (f.kind && f.kind !== 'all') out.push(f.kind === 'p' ? 'Podmioty lecznicze' : 'Praktyki zawodowe');
  for (const [k, vals] of Object.entries(f.sel ?? {})) {
    if (!vals?.length) continue;
    const key = k as FacetKey;
    const shown = vals.slice(0, 3).map((v) => labelOf?.(key, v) ?? VALUE_LABEL[key]?.[v] ?? v).join(', ');
    out.push(`${FACET_TITLE[key]}: ${shown}${vals.length > 3 ? ` (+${vals.length - 3})` : ''}`);
  }
  const c = f.contact ?? {};
  const have = [c.email && 'e-mail', c.tel && 'telefon', c.mobile && 'komórka', c.www && 'www', c.nip && 'NIP'].filter(Boolean);
  if (have.length) out.push(`Ma: ${have.join(', ')}`);
  if (f.q) out.push(`Szukaj: „${f.q}”`);
  if (f.miasto) out.push(`Miejscowość: ${f.miasto}`);
  if (f.wpisRel) out.push(`Wpis: ostatnie ${f.wpisRel} mies.`);
  else if (f.wpisOd || f.wpisDo) out.push(`Wpis: ${f.wpisOd ?? '…'} – ${f.wpisDo ?? '…'}`);
  if (f.stanOd) out.push(`Zmiana wpisu od ${f.stanOd}`);
  if (f.spec1Min) out.push(`Poradnie spec. ≥ ${f.spec1Min}`);
  if (f.nkMin) out.push(`Komórki ≥ ${f.nkMin}`);
  if (f.nipStatus?.length) out.push('Problem z NIP');
  if (f.accountPrimaryOnly) out.push('Tylko główny wpis konta');
  if (f.inRegister && f.inRegister !== 'yes') out.push(f.inRegister === 'no' ? 'Tylko zniknięte z rejestru' : 'Także zniknięte z rejestru');
  if (f.newInRun) out.push('Nowe w ostatnim imporcie');
  if (f.changedInRun) out.push('Zmienione w ostatnim imporcie');
  if (f.status?.length) out.push(`Status: ${f.status.map((id) => ref?.statuses.find((s) => s.id === id)?.name ?? id).join(', ')}`);
  if (f.owner?.length) {
    out.push(`Opiekun: ${f.owner.map((o) => (o === 'none' ? 'bez opiekuna' : o === 'me' ? 'ja' : (ref?.members.find((m) => m.id === o)?.displayName ?? o))).join(', ')}`);
  }
  if (f.tags?.length) out.push(`Tagi (${f.tagsMode === 'all' ? 'wszystkie' : 'dowolny'}): ${f.tags.map((id) => ref?.tags.find((t) => t.id === id)?.name ?? id).join(', ')}`);
  if (f.validation?.length) out.push(`Walidacja: ${f.validation.map((v) => ['niezweryfikowany', 'do sprawdzenia', 'zweryfikowany', 'odrzucony'][v]).join(', ')}`);
  if (f.nextStep) out.push(`Następny krok: ${NEXT_STEP_PL[f.nextStep]}`);
  if (f.dnc && f.dnc !== 'all') out.push(f.dnc === 'exclude' ? 'Bez „nie kontaktować”' : 'Tylko „nie kontaktować”');
  if (f.lastContact) out.push(`Ostatni kontakt: ${LAST_CONTACT_PL[f.lastContact]}`);
  if (f.listId) out.push(`Lista: ${ref?.lists.find((l) => l.id === f.listId)?.name ?? f.listId}`);
  if (f.network) out.push(f.network === 'any' ? 'W sieci' : f.network === 'none' ? 'Bez sieci' : 'Konkretna sieć');
  if (f.openProposal) out.push('Z otwartą propozycją walidacji');
  if (f.entityType?.length) out.push('Typ podmiotu');
  if (f.entryIds?.length) out.push(`Wybrane ręcznie: ${f.entryIds.length}`);
  return out;
}

export function activeFilterCount(f: LeadFilter): number {
  return describeFilter(f, null).length;
}
