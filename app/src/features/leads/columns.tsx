import type { ReactNode } from 'react';
import { ENTITY_TYPE_PL, QFLAG, SOURCE_LABEL_PL, VALIDATION_PL, type LeadRow, type RefData, type SortKey } from '../../lib/contract';
import { fmtDate, fmtNum, todayIso } from '../../lib/format';
import { Badge } from '../../components/common';

export interface Column {
  key: string;
  label: string;
  sort?: SortKey;
  optional?: boolean;
  render: (r: LeadRow, ref: RefData | null) => ReactNode;
}

const ENTITY_SHORT: Record<number, string> = { 1: 'Spółka', 2: 'JDG', 3: 'Publ.', 4: 'Prakt.', 5: 'Grup.' };

const memberOf = (ref: RefData | null, id: number | null) => (id === null ? '–' : (ref?.members.find((m) => m.id === id)?.displayName ?? `#${id}`));

export function qualityLabel(q: number | null): string {
  if (q === null) return '–';
  return q >= 70 ? `dobry (${q})` : q >= 40 ? `średni (${q})` : `słaby (${q})`;
}

export const COLUMNS: Column[] = [
  { key: 'name', label: 'Nazwa', sort: 'name', render: (r) => (
    <span className="name-cell">
      <span className="name-text" title={r.name ?? ''}>{r.name ?? '(bez nazwy)'}</span>
      {!r.inRegister ? <Badge tone="red">zniknął z rejestru</Badge> : null}
      {r.dnc ? <Badge tone="red">nie kontaktować</Badge> : null}
    </span>
  ) },
  { key: 'type', label: 'Typ', render: (r) => <span title={ENTITY_TYPE_PL[r.entityType]}>{ENTITY_SHORT[r.entityType]}</span> },
  // the city only, the voivodeship in the tooltip: the width goes to the name column (UX-R4-1)
  { key: 'miasto', label: 'Miejscowość', sort: 'miasto', render: (r) => (r.miasto || r.woj ? <span title={[r.miasto, r.woj ? `woj. ${r.woj}` : null].filter(Boolean).join(', ')}>{r.miasto || r.woj}</span> : '–') },
  { key: 'email', label: 'E-mail', render: (r) => <span className="ellipsis" title={r.email ?? ''}>{r.email ?? '–'}</span> },
  { key: 'tel', label: 'Telefon', render: (r) => (r.tel ? <span className="nowrap">{r.tel}{r.mobile ? <span className="muted"> (kom.)</span> : null}</span> : '–') },
  { key: 'status', label: 'Status', sort: 'status', render: (r, ref) => {
    const s = ref?.statuses.find((x) => x.id === r.statusId);
    return <span className="status-dot" style={{ ['--c' as string]: s?.color ?? '#999' }}>{s?.name ?? `#${r.statusId}`}</span>;
  } },
  { key: 'owner', label: 'Opiekun', sort: 'owner', render: (r, ref) => memberOf(ref, r.ownerId) },
  { key: 'next', label: 'Następny krok', sort: 'nextStep', render: (r) => {
    if (!r.nextStepAt) return '–';
    const overdue = r.nextStepAt.slice(0, 10) < todayIso();
    return <span className={overdue ? 'overdue' : undefined} title={r.nextStepNote ?? ''}>{fmtDate(r.nextStepAt)}</span>;
  } },
  { key: 'validation', label: 'Walidacja', render: (r) => (
    <Badge tone={r.validation === 2 ? 'green' : r.validation === 1 ? 'yellow' : r.validation === 3 ? 'red' : 'gray'}>
      {r.validationIsDerived ? <em>{VALIDATION_PL[r.validation]}</em> : VALIDATION_PL[r.validation]}
    </Badge>
  ) },
  { key: 'nip', label: 'NIP', optional: true, render: (r) => r.nip ?? '–' },
  { key: 'www', label: 'WWW', optional: true, render: (r) => r.www ?? '–' },
  { key: 'wpis', label: 'Data wpisu', sort: 'wpis', optional: true, render: (r) => fmtDate(r.wpis) },
  { key: 'stan', label: 'Ostatnia zmiana wpisu', sort: 'stan', optional: true, render: (r) => fmtDate(r.stan) },
  { key: 'spec1', label: 'Poradnie spec.', sort: 'spec1', optional: true, render: (r) => (r.spec1 === null ? '–' : fmtNum(r.spec1)) },
  { key: 'nz', label: 'Zakłady', optional: true, render: (r) => (r.nz === null ? '–' : fmtNum(r.nz)) },
  { key: 'nk', label: 'Komórki', sort: 'nk', optional: true, render: (r) => (r.nk === null ? '–' : fmtNum(r.nk)) },
  { key: 'last', label: 'Ostatni kontakt', sort: 'lastContact', optional: true, render: (r) => fmtDate(r.lastContactAt) },
  { key: 'tags', label: 'Tagi', optional: true, render: (r, ref) => r.tags.map((id) => ref?.tags.find((t) => t.id === id)?.name ?? id).join(', ') || '–' },
  { key: 'qEmail', label: 'Jakość e-maila', sort: 'qEmail', optional: true, render: (r) => qualityLabel(r.qEmail) },
  { key: 'qPhone', label: 'Jakość telefonu', optional: true, render: (r) => qualityLabel(r.qPhone) },
  { key: 'src', label: 'Źródło', optional: true, render: (r) => SOURCE_LABEL_PL[r.src] ?? r.src },
];

export const DEFAULT_COLUMNS = ['name', 'type', 'miasto', 'email', 'tel', 'status', 'owner', 'next', 'validation'];

/** Short list of problems from qflags, used by the validation screen and the card. */
export const QFLAG_TEXT: Array<[number, string]> = [
  [QFLAG.NIP_MISSING, 'brak NIP'], [QFLAG.NIP_BAD_FORMAT, 'NIP w złym formacie'], [QFLAG.NIP_PLACEHOLDER, 'NIP zastępczy (np. 0000000000)'],
  [QFLAG.NIP_CHECKSUM, 'NIP z błędną sumą kontrolną'], [QFLAG.NO_CONTACT, 'brak działającego kontaktu'], [QFLAG.EMAIL_INVALID, 'e-mail w złym formacie'],
  [QFLAG.EMAIL_TYPO, 'możliwa literówka w e-mailu'], [QFLAG.EMAIL_FREE, 'darmowa skrzynka e-mail'], [QFLAG.EMAIL_ROLE, 'adres recepcji / biura'],
  [QFLAG.EMAIL_SHARED, 'ten sam e-mail mają inne konta'], [QFLAG.PHONE_UNPARSEABLE, 'telefon nie do wybrania'], [QFLAG.PHONE_SHARED, 'telefon wspólny z innymi kontami'],
  [QFLAG.PHONE_SWITCHBOARD, 'prawdopodobnie centrala'], [QFLAG.WWW_INVALID, 'strona www w złym formacie'], [QFLAG.WWW_SOCIAL, 'strona www to profil społecznościowy'],
  [QFLAG.STALE, 'dane bez zmian od migracji rejestru (10.11.2023)'], [QFLAG.REG_DUPLICATE, 'zdublowany wpis w rejestrze'],
  [QFLAG.GROUP_NIP_IS_PARTNER, 'brak własnego NIP praktyki (podany NIP wspólnika)'], [QFLAG.INACTIVE, 'wpis nieaktywny'], [QFLAG.ACCOUNT_CHECK, 'konto do sprawdzenia'],
  [QFLAG.EMAIL_FROM_WWW, 'e-mail z pola WWW'],
];

export function qflagTexts(qflags: number): string[] {
  return QFLAG_TEXT.filter(([bit]) => (qflags & bit) !== 0).map(([, t]) => t);
}
