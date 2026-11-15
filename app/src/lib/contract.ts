/**
 * RPWZL CRM: the interface between the database (supabase/**) and the app (app/src/**).
 *
 * Single source of truth for names, codes and shapes. docs/CONTRACT.md explains every item; when this file and the
 * doc disagree, fix both in the same change. Owned by the architect; builders propose changes, never fork them.
 *
 * Conventions
 * - Every call is an RPC in the exposed schema `api` (supabase.rpc(name, args)); no table is reachable from the client.
 * - RPC argument names are snake_case with a `p_` prefix (Postgres function parameters); payload/return objects use
 *   the camelCase keys declared below (the SQL builds them with jsonb_build_object).
 * - Dates are 'YYYY-MM-DD' strings, timestamps ISO 8601 strings with offset, int64 values decimal strings.
 * - Every id is a number (int4) unless stated otherwise.
 */

export const API_SCHEMA = 'api' as const;
export const CONTRACT_VERSION = 1 as const;

/* ------------------------------------------------------------------------------------------------------------------
 * Errors. SQL raises `raise exception using errcode = '<code>', message = '<key>', detail = '<english detail>'`.
 * supabase-js surfaces them as error.code / error.message. The app maps the code to Polish text (ERROR_TEXT_PL).
 * ---------------------------------------------------------------------------------------------------------------- */
export const ERR = {
  NOT_SIGNED_IN: 'CR401', // no JWT / expired session
  NOT_MEMBER: 'CR402', // signed in, but e-mail not on the team_member allowlist or inactive
  FORBIDDEN: 'CR403', // role too low (member calling an owner-only RPC) or rule (e.g. only owner clears dnc)
  NOT_FOUND: 'CR404',
  CONFLICT: 'CR409', // optimistic-lock version mismatch, or unique name taken
  TOO_LARGE: 'CR413', // batch / bulk / page above its limit
  INVALID: 'CR422', // payload fails validation (detail names the field)
  LOCKED: 'CR423', // another import run is in progress
  LAST_OWNER: 'CR424', // would remove/demote the last active owner
} as const;
export type ErrorCode = (typeof ERR)[keyof typeof ERR];

export const ERROR_TEXT_PL: Record<ErrorCode, string> = {
  CR401: 'Sesja wygasła. Zaloguj się ponownie.',
  CR402: 'To konto nie ma dostępu do CRM. Poproś właściciela o dodanie Twojego adresu e-mail.',
  CR403: 'Nie masz uprawnień do tej operacji.',
  CR404: 'Nie znaleziono rekordu (mógł zostać usunięty).',
  CR409: 'Ktoś właśnie zmienił ten rekord. Odśwież widok i spróbuj ponownie.',
  CR413: 'Za dużo rekordów naraz. Zawęź wybór.',
  CR422: 'Nieprawidłowe dane. Sprawdź formularz.',
  CR423: 'Trwa inny import. Poczekaj na jego zakończenie.',
  CR424: 'W CRM musi zostać co najmniej jeden aktywny właściciel.',
};

/** Texts for specific error keys (the `message` of a CR error) that need more than the generic text of their code. */
export const ERROR_KEY_TEXT_PL: Readonly<Record<string, string>> = {
  dictionary_full: 'Słownik wartości rejestru (specjalności, rodzaje działalności…) jest pełny. Ponowienie importu nie pomoże — skontaktuj się z administratorem CRM.',
  database_full: 'Baza danych jest prawie pełna (ponad 450 MB). Zwolnij miejsce (np. zmniejsz historię rejestru w Ustawieniach) albo skontaktuj się z administratorem.',
  account_check_first: 'Jedno z tych kont zawiera wpisy innych osób lub firmy. Najpierw rozdziel to konto („Rozdziel ten wpis” albo propozycja „ten sam NIP”), potem potwierdź tę osobę.',
};

/* ------------------------------------------------------------------------------------------------------------------
 * Enumerations (stored as small integers or short text; codes never change once shipped)
 * ---------------------------------------------------------------------------------------------------------------- */
export type Role = 'owner' | 'member';
export type Kind = 'p' | 'r'; // p = podmiot leczniczy (Rpm), r = praktyka zawodowa (all other sources)

/** Register sources in the index order (SPEC.md of the offline tool, section 1). The array index is `src` in the DB. */
export const SOURCES = ['Rpm', 'Rpz', 'Rpzg', 'Rpzp', 'Rpzpg', 'Rpf', 'Rpfg', 'Rpdl', 'Rpdlg'] as const;
export type SourceId = (typeof SOURCES)[number];
export const SOURCE_LABEL_PL: Record<SourceId, string> = {
  Rpm: 'Podmioty lecznicze',
  Rpz: 'Praktyki lekarskie indywidualne',
  Rpzg: 'Praktyki lekarskie grupowe',
  Rpzp: 'Praktyki pielęgniarskie indywidualne',
  Rpzpg: 'Praktyki pielęgniarskie grupowe',
  Rpf: 'Praktyki fizjoterapeutyczne indywidualne',
  Rpfg: 'Praktyki fizjoterapeutyczne grupowe',
  Rpdl: 'Praktyki diagnostów laboratoryjnych indywidualne',
  Rpdlg: 'Praktyki diagnostów laboratoryjnych grupowe',
};

/** Validation typing of an entry ("kto jest kim"), SPEC.md 6.1. */
export const ENTITY_TYPE = { PODMIOT_PRAWNY: 1, JDG: 2, PUBLICZNY: 3, PRAKTYKA_IND: 4, PRAKTYKA_GRUP: 5 } as const;
export type EntityType = (typeof ENTITY_TYPE)[keyof typeof ENTITY_TYPE];
export const ENTITY_TYPE_PL: Record<EntityType, string> = {
  1: 'Spółka / podmiot prawny',
  2: 'Osoba fizyczna prowadząca podmiot (JDG)',
  3: 'Podmiot publiczny',
  4: 'Praktyka indywidualna',
  5: 'Praktyka grupowa',
};

/** NIP check result, SPEC.md 6.3. */
export const NIP_STATUS = { NONE: 0, OK: 1, BAD_FORMAT: 2, PLACEHOLDER: 3, CHECKSUM: 4 } as const;
export type NipStatus = (typeof NIP_STATUS)[keyof typeof NIP_STATUS];

/** Contact presence bits (same bit order as the offline tool's kontakt mask). reg_entry.cflags */
export const CFLAG = { EMAIL: 1, TEL: 2, WWW: 4, NIP: 8, MOBILE: 16 } as const;

/** Validation problem/quality bits, reg_entry.qflags (computed by the import worker, SPEC.md 6.5). */
export const QFLAG = {
  NIP_MISSING: 1 << 0,
  NIP_BAD_FORMAT: 1 << 1,
  NIP_PLACEHOLDER: 1 << 2,
  NIP_CHECKSUM: 1 << 3,
  NO_CONTACT: 1 << 4,
  EMAIL_INVALID: 1 << 5,
  EMAIL_TYPO: 1 << 6,
  EMAIL_FREE: 1 << 7,
  EMAIL_ROLE: 1 << 8,
  EMAIL_SHARED: 1 << 9,
  PHONE_UNPARSEABLE: 1 << 10,
  PHONE_SHARED: 1 << 11,
  PHONE_SWITCHBOARD: 1 << 12,
  WWW_INVALID: 1 << 13,
  WWW_SOCIAL: 1 << 14,
  STALE: 1 << 15,
  REG_DUPLICATE: 1 << 16,
  GROUP_NIP_IS_PARTNER: 1 << 17,
  INACTIVE: 1 << 18,
  ACCOUNT_CHECK: 1 << 19,
  EMAIL_FROM_WWW: 1 << 20,
  /** a mobile number of the entry is listed by 5 or more owners (a call centre, not a personal mobile); it stays in `nums` but
   *  is never `mobile`, so 'ma komórkę' and the Customer.io sms_phone skip it (VAL-R3-6) */
  MOBILE_SHARED: 1 << 21,
} as const;
/** Bits that make the derived validation status 'do_sprawdzenia' when no human has set one. */
export const QFLAG_PROBLEM_MASK =
  QFLAG.NIP_BAD_FORMAT | QFLAG.NIP_PLACEHOLDER | QFLAG.NIP_CHECKSUM | QFLAG.NO_CONTACT | QFLAG.EMAIL_INVALID |
  QFLAG.EMAIL_TYPO | QFLAG.PHONE_UNPARSEABLE | QFLAG.REG_DUPLICATE | QFLAG.ACCOUNT_CHECK;

export const VALIDATION = { NIEZWERYFIKOWANY: 0, DO_SPRAWDZENIA: 1, ZWERYFIKOWANY: 2, ODRZUCONY: 3 } as const;
export type ValidationStatus = (typeof VALIDATION)[keyof typeof VALIDATION];
export const VALIDATION_PL: Record<ValidationStatus, string> = {
  0: 'Niezweryfikowany',
  1: 'Do sprawdzenia',
  2: 'Zweryfikowany',
  3: 'Odrzucony',
};

/** Checklist filled after a call (lead.checklist). Every key optional. */
export interface ValidationChecklist {
  podmiotDziala?: boolean | null; // 'Podmiot istnieje i działa pod tym adresem'
  profilPasuje?: boolean | null; // 'Profil pasuje do naszej oferty'
  telefonOk?: boolean | null; // 'Telefon działa i należy do tego podmiotu'
  emailOk?: boolean | null; // 'E-mail potwierdzony'
  wwwOk?: boolean | null;
  decydent?: string | null; // 'Osoba decyzyjna (imię, stanowisko)'
  siec?: 'tak' | 'nie' | 'nie_wiem' | null; // 'Należy do sieci / grupy'
  uwagi?: string | null;
}

export type ActivityType = 'call' | 'sms' | 'email' | 'meeting' | 'note' | 'status' | 'owner' | 'validation' | 'dnc' | 'task';
/** Types a user may create with activity_add; the others are written by the server as side effects. */
export const USER_ACTIVITY_TYPES = ['call', 'sms', 'email', 'meeting', 'note'] as const;
export type UserActivityType = (typeof USER_ACTIVITY_TYPES)[number];
export const OUTCOMES: Record<UserActivityType, readonly string[]> = {
  call: ['rozmowa', 'nie_odbiera', 'zajete', 'poczta_glosowa', 'sekretariat', 'oddzwonic', 'zly_numer', 'nie_zainteresowany', 'nie_chce_kontaktu'],
  sms: ['wyslano', 'odpowiedz'],
  email: ['wyslano', 'odpowiedz', 'odbity'],
  meeting: ['odbyte', 'odwolane', 'przelozone'],
  note: [],
};
export const OUTCOME_PL: Record<string, string> = {
  rozmowa: 'Rozmowa', nie_odbiera: 'Nie odbiera', zajete: 'Zajęte', poczta_glosowa: 'Poczta głosowa',
  sekretariat: 'Sekretariat / recepcja', oddzwonic: 'Prośba o kontakt później', zly_numer: 'Zły numer',
  nie_zainteresowany: 'Nie jest zainteresowany', nie_chce_kontaktu: 'Prosi o brak kontaktu',
  wyslano: 'Wysłano', odpowiedz: 'Odpowiedź', odbity: 'Odbity (nie doszedł)',
  odbyte: 'Odbyte', odwolane: 'Odwołane', przelozone: 'Przełożone',
};

export type TemplateKind = 'email' | 'sms' | 'call';
export const TEMPLATE_VARIABLES = [
  'nazwa', 'nazwa_krotka', 'miasto', 'ulica', 'kod', 'woj', 'nip', 'osoba',
  'opiekun', 'opiekun_telefon', 'opiekun_email', 'ja', 'ja_telefon', 'ja_email', 'data',
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export type ProposalKind = 'account_check' | 'person' | 'partner' | 'email' | 'domain' | 'www' | 'phone' | 'reg_duplicate';
export const PROPOSAL_KIND_PL: Record<ProposalKind, string> = {
  account_check: 'Konto do sprawdzenia (ten sam NIP)',
  person: 'Ta sama osoba (ten sam numer prawa wykonywania zawodu)',
  partner: 'Wspólnik (NIP wspólnika = NIP innego wpisu)',
  email: 'Ten sam adres e-mail',
  domain: 'Ta sama domena e-mail',
  www: 'Ta sama strona WWW',
  phone: 'Ten sam numer telefonu',
  reg_duplicate: 'Zdublowany wpis w rejestrze',
};
export const PROPOSAL_STATUS = { OPEN: 0, ACCEPTED: 1, REJECTED: 2, STALE: 3 } as const;
export type ProposalStatus = (typeof PROPOSAL_STATUS)[keyof typeof PROPOSAL_STATUS];
export type ValidationQueue = 'accounts' | 'networks' | 'records';

/* ------------------------------------------------------------------------------------------------------------------
 * Filters, sorting, paging (leads list, bulk actions, exports, saved views)
 * ---------------------------------------------------------------------------------------------------------------- */

/** Facet keys. Values are the register strings as found in the data (labels via api.dict). */
export const P_FACETS = ['p.status', 'p.rodzaje', 'p.grp', 'p.spec', 'p.dz', 'p.fn', 'p.forma', 'p.formType', 'p.woj'] as const;
export const R_FACETS = ['r.src', 'r.grupaPraktyk', 'r.gz', 'r.typ', 'r.rodzaj', 'r.rd', 'r.spec', 'r.zakres', 'r.forma', 'r.organ', 'r.status', 'r.woj'] as const;
export type FacetKey = (typeof P_FACETS)[number] | (typeof R_FACETS)[number];

export type NextStepFilter = 'overdue' | 'today' | 'week' | 'none' | 'any' | 'due';
export type LastContactFilter = 'never' | '7d' | '30d' | '90d' | 'older90';

export interface LeadFilter {
  /** 'p' | 'r' | 'all' (default 'all'). Facets of the other kind are ignored. */
  kind?: Kind | 'all';
  /** OR within a facet, AND across facets. With kind 'all' a facet of one kind restricts only rows of that kind.
   *  `p.fn` values are tree prefixes ('HC.1.' matches 'HC.1.3.3.'); a value ending with '=' matches that code exactly. */
  sel?: Partial<Record<FacetKey, string[]>>;
  /** true = must have; omitted/false = no restriction */
  contact?: { email?: boolean; tel?: boolean; www?: boolean; nip?: boolean; mobile?: boolean };
  /** name / NIP / e-mail / phone, case- and diacritics-insensitive "contains"; 9+ digits also match any phone number */
  q?: string;
  miasto?: string; // contains, diacritics-insensitive
  wpisOd?: string; // register entry date, inclusive
  wpisDo?: string;
  wpisRel?: 0 | 1 | 6 | 12; // months before the latest import's report date; > 0 overrides wpisOd/wpisDo
  stanOd?: string; // last register change >= date
  spec1Min?: number; // p only: distinct specialist clinics (group 1, no 18xx) >= n
  nkMin?: number; // p only: active komórki >= n
  entityType?: EntityType[];
  nipStatus?: NipStatus[];
  qflagsAny?: number; // entries with any of these QFLAG bits
  inRegister?: 'yes' | 'no' | 'all'; // default 'yes'
  accountPrimaryOnly?: boolean; // one row per account (the account's primary entry)
  newInRun?: number | 'last'; // first imported in that run
  changedInRun?: number | 'last'; // register data changed in that run
  // CRM filters
  status?: number[];
  owner?: Array<number | 'none' | 'me'>; // team_member ids; 'none' = unassigned; 'me' = the caller (saved views)
  tags?: number[];
  tagsMode?: 'any' | 'all'; // default 'any'
  validation?: ValidationStatus[]; // effective status (human-set, else derived)
  nextStep?: NextStepFilter;
  dnc?: 'all' | 'exclude' | 'only'; // default 'all' in lists; exports always exclude unless includeDnc
  lastContact?: LastContactFilter;
  listId?: number;
  network?: 'any' | 'none' | number;
  openProposal?: boolean; // member of an open validation proposal
  entryIds?: number[]; // explicit selection (max 5000)
}

export type SortKey = 'name' | 'miasto' | 'wpis' | 'stan' | 'status' | 'owner' | 'nextStep' | 'lastContact' | 'qEmail' | 'spec1' | 'nk' | 'updated';
export interface LeadSort { key: SortKey; dir: 'asc' | 'desc' }
export const PAGE_LIMIT_MAX = 200;

/** One row of the leads list (api.leads_search). */
export interface LeadRow {
  id: number;
  kind: Kind;
  src: SourceId;
  name: string | null;
  nip: string | null;
  email: string | null; // primary: CRM primary e-mail if set, else register
  tel: string | null; // raw register phone (or CRM primary phone)
  mobile: string | null; // 9 digits
  www: string | null;
  miasto: string | null;
  woj: string | null;
  wpis: string | null;
  stan: string | null;
  nz: number | null;
  nk: number | null;
  spec1: number | null;
  entityType: EntityType;
  inRegister: boolean;
  qEmail: number | null;
  qPhone: number | null;
  qflags: number;
  accountKey: string;
  accountSize: number;
  // CRM
  statusId: number; // default status when no lead row exists
  ownerId: number | null;
  tags: number[];
  validation: ValidationStatus; // effective
  validationIsDerived: boolean;
  dnc: boolean;
  nextStepAt: string | null;
  nextStepNote: string | null;
  lastContactAt: string | null;
  networkId: number | null;
  version: number; // 0 when no lead row exists yet
}

export interface LeadsSummary { total: number; email: number; tel: number; www: number; nip: number; mobile: number }
/** api.leads_facets: per facet a list of [value, count] (counts honour every OTHER filter). */
export type FacetCounts = Partial<Record<FacetKey, Array<[string, number]>>>;

export interface DictEntry { facet: string; val: string; label: string | null }

/* ------------------------------------------------------------------------------------------------------------------
 * Record card (api.lead_get)
 * ---------------------------------------------------------------------------------------------------------------- */

/** Register-only part of the card: the index record without the fields kept as columns, plus the parsed detail `d`
 *  (structure: offline tool SPEC.md V2.5.1). p: {emails, phones, ulica, rodzaje, dz, fn, d}; r: {phones, ulica, rodzaj, rd, d}. */
export interface RegisterRec {
  emails?: string[];
  phones?: string[];
  ulica?: string | null;
  rodzaje?: string[];
  dz?: string[];
  fn?: string[];
  rodzaj?: string[];
  rd?: string[];
  d: Record<string, unknown> | null;
}

export interface LeadCard {
  row: LeadRow;
  regKey: string;
  ks: string;
  org: string | null;
  kod: string | null;
  facets: Partial<Record<FacetKey, string[]>>; // all facet values of the entry
  rec: RegisterRec | null;
  lead: {
    shortName: string | null;
    dncReason: string | null;
    dncAt: string | null;
    validationNote: string | null;
    checklist: ValidationChecklist | null;
    validatedAt: string | null;
    validatedBy: number | null;
    regChangedAfterValidation: boolean;
  } | null;
  contacts: LeadContact[]; // CRM-entered contacts and overrides of register values
  account: LeadRow[]; // other entries of the same account (max 50)
  network: { id: number; name: string; members: number } | null;
  proposals: ProposalSummary[]; // open + decided proposals involving this account
  lists: Array<{ id: number; name: string }>;
  phoneOwners: Record<string, number>; // 9-digit number -> number of accounts using it
  firstRun: { id: number; reportDate: string } | null;
  lastChange: { runId: number; reportDate: string } | null;
}

export interface LeadContact {
  id: number;
  kind: 'email' | 'phone' | 'www' | 'person';
  value: string | null;
  personName: string | null;
  personRole: string | null;
  status: 'ok' | 'invalid' | 'unknown';
  isPrimary: boolean;
  source: 'crm' | 'register'; // 'register' = an override (e.g. "zły numer") of a value that comes from the register
  note: string | null;
  updatedAt: string;
}

export interface TimelineItem {
  id: string; // 'a:<activity id>' | 'c:<run>:<entry>' | 't:<task id>'
  at: string;
  entryId: number;
  source: 'activity' | 'register' | 'task';
  type: ActivityType | 'register_new' | 'register_changed' | 'register_gone' | 'register_returned';
  outcome: string | null;
  contactValue: string | null;
  subject: string | null;
  body: string | null;
  statusFrom: number | null;
  statusTo: number | null;
  fields: string[] | null; // register change: changed field names
  old: Record<string, unknown> | null; // register change: old values of changed contact fields
  byId: number | null; // team_member id
  editable: boolean;
}

/* ------------------------------------------------------------------------------------------------------------------
 * Write payloads
 * ---------------------------------------------------------------------------------------------------------------- */
export interface LeadPatch {
  statusId?: number;
  ownerId?: number | null;
  tags?: number[];
  shortName?: string | null;
  nextStepAt?: string | null;
  nextStepNote?: string | null;
  validation?: ValidationStatus | null; // null = back to derived
  validationNote?: string | null;
  checklist?: ValidationChecklist | null;
  dnc?: boolean; // clearing (false) is owner-only
  dncReason?: string | null;
}

export interface ActivityInput {
  type: UserActivityType;
  outcome?: string | null;
  contactValue?: string | null; // phone/e-mail used
  subject?: string | null;
  body?: string | null; // max 5000 chars
  occurredAt?: string; // default now()
  templateId?: number | null;
  // optional side effects in the same transaction ("log outcome" form)
  statusId?: number;
  nextStepAt?: string | null;
  nextStepNote?: string | null;
  dnc?: boolean; // set only (true)
  dncReason?: string | null;
  task?: { title: string; dueDate: string; assigneeId?: number; note?: string | null } | null;
}

export type BulkTarget = { entryIds: number[] } | { filter: LeadFilter };
export type BulkAction =
  | { action: 'set_status'; statusId: number }
  | { action: 'set_owner'; ownerId: number | null }
  | { action: 'add_tag'; tagId: number }
  | { action: 'remove_tag'; tagId: number }
  | { action: 'add_to_list'; listId: number }
  | { action: 'remove_from_list'; listId: number }
  | { action: 'set_validation'; validation: ValidationStatus | null }
  | { action: 'set_dnc'; dnc: boolean; reason?: string | null };
export const BULK_MAX = 20000;

export interface Task {
  id: number;
  entryId: number | null;
  entryName: string | null;
  title: string;
  note: string | null;
  dueDate: string;
  dueTime: string | null; // 'HH:MM'
  assigneeId: number;
  doneAt: string | null;
  createdBy: number;
  createdAt: string;
}
export type TaskInput = Partial<Pick<Task, 'id' | 'entryId' | 'note' | 'dueTime'>> & { title: string; dueDate: string; assigneeId?: number };

export interface Template { id: number; kind: TemplateKind; name: string; subject: string | null; body: string; active: boolean; sort: number; updatedAt: string }
export interface LeadList { id: number; name: string; note: string | null; members: number; createdBy: number; updatedAt: string }
export interface SavedView {
  id: number;
  name: string;
  scope: 'system' | 'shared' | 'private';
  ownerId: number | null;
  filter: LeadFilter;
  sort: LeadSort | null;
  columns: string[] | null;
  note: string | null;
  sortOrder: number;
}
export interface LeadStatus { id: number; name: string; color: string; sort: number; stage: 'open' | 'won' | 'lost' | 'paused'; isDefault: boolean; active: boolean }
export interface Tag { id: number; name: string; color: string }
export interface TeamMember { id: number; email: string; displayName: string; role: Role; phone: string | null; active: boolean; hasLoggedIn: boolean; lastSeenAt: string | null }

export interface Me { memberId: number; email: string; displayName: string; role: Role; phone: string | null }
export interface RefData {
  me: Me;
  statuses: LeadStatus[];
  tags: Tag[];
  members: Array<Pick<TeamMember, 'id' | 'displayName' | 'role' | 'active' | 'phone' | 'email'>>;
  views: SavedView[];
  lists: LeadList[];
  lastImport: { id: number; reportDate: string; finishedAt: string } | null;
  settings: PublicSettings;
}
export interface PublicSettings {
  staleDays: number; // banner when the latest report date is older (default 35)
  valMinConfidence: number; // proposals below are hidden (default 50)
  smsDiacritics: 'keep' | 'strip'; // default 'keep'
}

export interface TodayData {
  tasksOverdue: Task[];
  tasksToday: Task[];
  nextSteps: LeadRow[]; // my leads with nextStepAt <= today (max 100)
  registerChanges: Array<{ row: LeadRow; change: 'changed' | 'gone' | 'returned'; fields: string[] }>; // my non-'Nowy' leads changed in the latest run
  counts: { tasksOverdue: number; tasksToday: number; nextSteps: number; registerChanges: number; openProposals: number };
}

/* ------------------------------------------------------------------------------------------------------------------
 * Validation (Walidacja screen)
 * ---------------------------------------------------------------------------------------------------------------- */
export interface ProposalSummary {
  id: number;
  kind: ProposalKind;
  matchValue: string;
  confidence: number; // 0..100
  groupKey: string; // proposals with identical member sets share it (UI groups them)
  status: ProposalStatus;
  members: string[]; // account keys
  newMembers: string[]; // keys added since the last decision
  decidedBy: number | null;
  decidedAt: string | null;
  note: string | null;
  networkId: number | null;
}
export interface ProposalDetail extends ProposalSummary {
  /** entries of all member accounts (max 100) */
  entries: LeadRow[];
  /** open `account_check` only: ids of the entries a reject ("to różne podmioty") detaches (private.minority_entries, VAL-R5-1) */
  detachIds?: number[];
}
export interface ValSummary {
  queues: Record<ValidationQueue, { open: number; decided: number }>;
  byKind: Partial<Record<ProposalKind, number>>; // open
  records: { doSprawdzenia: number; zweryfikowany: number; odrzucony: number; niezweryfikowany: number };
}
export type ProposalDecision =
  | { decision: 'accept'; networkId?: number; newNetworkName?: string; memberKeys?: string[]; note?: string | null }
  | { decision: 'reject'; note?: string | null }
  | { decision: 'reopen' };
export interface Network { id: number; name: string; note: string | null; accounts: number; entries: number; createdAt: string }

/** Decisions the import worker must respect when it recomputes accounts and proposals (api.val_decisions). */
export interface ValDecisions {
  detach: string[]; // key hashes (16 hex) of entries split out of their NIP account
  attach: Array<{ keyHash: string; accountKey: string }>; // entries moved into another account
  genericDomains: Array<{ domain: string; kind: 'free' | 'generic' | 'typo' | 'social'; suggestion: string | null }>;
  /** Decided proposals (status accepted/rejected) with the members they were decided on: one that the import computes again
   *  with no member beyond these stays decided, so the preview does not count it as waiting. */
  decidedProposals: Array<{ kind: ProposalKind; matchValue: string; members: string[] }>;
  params: ValidationParams;
}
export interface ValidationParams {
  genericDomainAccounts: number; // a company domain used by >= this many accounts in >= 3 voivodeships is generic (30)
  emailClusterMax: number; // 30
  domainClusterMax: number; // 50
  wwwClusterMax: number; // 50
  phoneClusterMax: number; // 3
  staleBefore: string; // '2023-11-10' (register migration date): stan <= this is stale
}

/* ------------------------------------------------------------------------------------------------------------------
 * Import (owner). The worker parses the index file (format 'rpwdl-lead-index' v2) and talks to these RPCs.
 * ---------------------------------------------------------------------------------------------------------------- */
export const HASH_VERSION = 1 as const;
export const IMPORT_BATCH_ROWS = 500; // api.import_entries max rows per call (CR413 above 1000)
export const IMPORT_STATE_PAGE = 20000; // api.import_state rows per page

export interface ImportBeginInput {
  fileName: string;
  fileSha256: string; // hex of the whole .json.gz file
  indexVersion: 2;
  createdAt: string | null; // index header createdAt
  today: string; // index header today
  reportDate: string; // oldest sources[].reportDate
  sources: Array<{ id: SourceId; records: number; reportDate: string | null; today: string | null; bad: number }>;
  hashVersion: typeof HASH_VERSION;
  preview: ImportCounts; // what the worker computed against api.import_state
}
export interface ImportCounts { total: number; new: number; changed: number; changedContact: number; returned: number; gone: number; unchanged: number; derivedOnly: number; rejected: number }

/** One line of api.import_state().data, tab separated: id, keyHash, hAll, hContact, hDerived, inRegister(1/0), src. */
export interface ImportStateRow { id: number; keyHash: string; hAll: string; hContact: string; hDerived: string; inRegister: boolean; src: number }

/** Derived (validation) fields computed by the worker for every entry. */
export interface DerivedFields {
  nipStatus: NipStatus;
  entityType: EntityType;
  accountKey: string; // 'n:<nip>' | 'e:<keyHash>'
  accountSize: number;
  isAccountPrimary: boolean;
  telShared: number | null;
  qEmail: number | null;
  qPhone: number | null;
  qflags: number;
  mobile: string | null; // 9 digits
  telNorm: string | null; // 9 digits
  nums: string[]; // all parsed 9-digit numbers, tel first
  formType: 'komercyjna' | 'publiczna' | 'inna' | null; // p only
  spec1: number | null; // p only
}

/** Row of api.import_entries (new, changed or returned entries). Built from one index record (CONTRACT.md 6). */
export interface ImportEntryRow {
  keyHash: string; // 16 hex = first 8 bytes of SHA-256(regKey)
  regKey: string; // `${src}|${org}|${ks}|${kseq}`
  kind: Kind;
  src: SourceId;
  org: string; // d.org (p) or organ (r); '' if missing
  ks: string;
  kseq: number;
  name: string | null;
  nip: string | null;
  email: string | null;
  tel: string | null;
  www: string | null;
  emails: string[]; // p only, [] for r
  miasto: string | null;
  kod: string | null;
  wpis: string | null;
  stan: string | null;
  nz: number | null;
  nk: number | null;
  facets: Partial<Record<FacetKey, string[]>>; // scalar facets as one-element arrays; formType included for p
  derived: DerivedFields;
  rec: RegisterRec; // stored in the detail block
  hAll: string; // decimal int64 strings
  hContact: string;
  hDerived: string;
}
export interface ImportDerivedRow { keyHash: string; derived: DerivedFields; hDerived: string }
export interface ImportProposalRow {
  kind: ProposalKind;
  matchValue: string;
  confidence: number;
  groupKey: string;
  members: string[]; // account keys, sorted
}
export interface ImportRun {
  id: number;
  status: 'running' | 'applied' | 'failed' | 'aborted';
  fileName: string;
  reportDate: string;
  startedAt: string;
  finishedAt: string | null;
  startedBy: number;
  counts: ImportCounts | null;
  error: string | null;
}
export interface ImportChangeRow {
  row: LeadRow;
  change: 'new' | 'changed' | 'gone' | 'returned';
  fields: string[];
  old: Record<string, unknown> | null;
}

/* ------------------------------------------------------------------------------------------------------------------
 * Export and backup (owner)
 * ---------------------------------------------------------------------------------------------------------------- */
export type ExportFormat = 'csv' | 'customerio';
export interface ExportOptions {
  includeDnc?: boolean; // default false
  dedupe?: 'none' | 'nip' | 'email'; // csv default 'nip'; customerio default 'email'
  requireEmail?: boolean; // customerio default true
}
export interface ExportRow {
  id: number;
  regKey: string;
  keyHash: string;
  kind: Kind;
  src: SourceId;
  name: string | null;
  shortName: string | null;
  nip: string | null;
  email: string | null; // best e-mail (CRM primary > register primary), never one marked invalid
  emails: string[]; // all valid e-mails
  tel: string | null;
  mobile: string | null;
  phones: string[];
  www: string | null;
  miasto: string | null;
  woj: string | null;
  ulica: string | null;
  kod: string | null;
  forma: string | null;
  formType: string | null;
  entityType: EntityType;
  status: string;
  owner: string | null;
  tags: string[];
  validation: ValidationStatus;
  nextStepAt: string | null;
  lastContactAt: string | null;
  wpis: string | null;
  stan: string | null;
  spec1: number | null;
  nz: number | null;
  nk: number | null;
  qEmail: number | null;
  dnc: boolean;
  inRegister: boolean; // false for an entry that has left the register
  firstImportedAt: string; // timestamp of the run that first imported the entry
}
export const EXPORT_PAGE_MAX = 5000;

export const BACKUP_TABLES = [
  'team_member', 'lead_status', 'tag', 'app_setting', 'lead', 'lead_contact', 'activity', 'task', 'template',
  'list', 'list_member', 'saved_view', 'network', 'network_member', 'val_proposal', 'val_decision', 'generic_domain',
] as const;
export type BackupTable = (typeof BACKUP_TABLES)[number];
export interface BackupFile {
  format: 'rpwzl-crm-backup';
  version: 1;
  createdAt: string;
  contractVersion: typeof CONTRACT_VERSION;
  tables: Partial<Record<BackupTable, Record<string, unknown>[]>>; // entry references as regKey strings, never internal ids
}

export interface DbUsage { bytes: number; limitBytes: number; dictValues?: number; dictLimit?: number; tables: Array<{ name: string; bytes: number }> }

/* ------------------------------------------------------------------------------------------------------------------
 * RPC catalogue: name -> [args, result]. A typed wrapper (app/src/lib/api.ts, APP builder) uses this map.
 * ---------------------------------------------------------------------------------------------------------------- */
export interface Rpc {
  me: [Record<string, never>, Me];
  ref_data: [Record<string, never>, RefData];
  dict: [{ p_facets: string[] }, DictEntry[]];

  leads_search: [{ p_filter: LeadFilter; p_sort: LeadSort | null; p_offset: number; p_limit: number }, { rows: LeadRow[] }];
  leads_count: [{ p_filter: LeadFilter }, LeadsSummary];
  leads_facets: [{ p_filter: LeadFilter; p_facets: FacetKey[] }, FacetCounts];
  lead_get: [{ p_entry_id: number }, LeadCard];
  lead_timeline: [{ p_entry_id: number; p_scope: 'entry' | 'account'; p_before: string | null; p_limit: number }, TimelineItem[]];
  lead_update: [{ p_entry_id: number; p_version: number; p_patch: LeadPatch }, LeadRow];
  leads_bulk: [{ p_target: BulkTarget; p_action: BulkAction }, { affected: number }];
  activity_add: [{ p_entry_id: number; p_activity: ActivityInput }, { activityId: number; row: LeadRow }];
  activity_update: [{ p_id: number; p_patch: Pick<ActivityInput, 'outcome' | 'subject' | 'body' | 'occurredAt'> }, TimelineItem];
  activity_delete: [{ p_id: number }, { deleted: true }];
  contact_upsert: [{ p_entry_id: number; p_contact: Partial<LeadContact> & Pick<LeadContact, 'kind'> }, LeadContact];
  contact_delete: [{ p_id: number }, { deleted: true }];

  tasks_list: [{ p_scope: 'mine' | 'all'; p_open: boolean; p_due_to: string | null; p_entry_id: number | null; p_offset: number; p_limit: number }, Task[]];
  task_upsert: [{ p_task: TaskInput }, Task];
  task_done: [{ p_id: number; p_done: boolean }, Task];
  task_delete: [{ p_id: number }, { deleted: true }];
  today: [Record<string, never>, TodayData];

  templates_list: [Record<string, never>, Template[]];
  template_upsert: [{ p_template: Partial<Template> & Pick<Template, 'kind' | 'name' | 'body'> }, Template];
  template_delete: [{ p_id: number }, { deleted: true }];
  lists_list: [Record<string, never>, LeadList[]];
  list_upsert: [{ p_list: { id?: number; name: string; note?: string | null } }, LeadList];
  list_delete: [{ p_id: number }, { deleted: true }];
  views_list: [Record<string, never>, SavedView[]];
  view_upsert: [{ p_view: Partial<SavedView> & Pick<SavedView, 'name' | 'filter'> }, SavedView];
  view_delete: [{ p_id: number }, { deleted: true }];

  val_summary: [{ p_filter: LeadFilter | null }, ValSummary];
  val_queue: [{ p_queue: Exclude<ValidationQueue, 'records'>; p_status: ProposalStatus | null; p_filter: LeadFilter | null; p_offset: number; p_limit: number }, ProposalSummary[]];
  val_proposal_get: [{ p_id: number }, ProposalDetail];
  val_decide: [{ p_id: number; p_decision: ProposalDecision }, ProposalSummary];
  val_account_link: [{ p_entry_id: number; p_action: 'detach' | 'attach'; p_account_key: string | null; p_note: string | null }, LeadRow[]];
  val_decisions: [Record<string, never>, ValDecisions];
  networks_list: [Record<string, never>, Network[]];
  network_upsert: [{ p_network: { id?: number; name: string; note?: string | null } }, Network];
  network_member_remove: [{ p_network_id: number; p_account_key: string }, { removed: true }];

  import_begin: [{ p_meta: ImportBeginInput }, { runId: number }];
  import_state: [{ p_after_id: number; p_limit: number }, { data: string; nextAfterId: number | null }];
  import_labels: [{ p_run_id: number; p_labels: DictEntry[] }, { upserted: number }];
  import_entries: [{ p_run_id: number; p_rows: ImportEntryRow[] }, { inserted: number; updated: number; returned: number }];
  import_derived: [{ p_run_id: number; p_rows: ImportDerivedRow[] }, { updated: number }];
  import_gone: [{ p_run_id: number; p_key_hashes: string[] }, { gone: number }];
  import_proposals: [{ p_run_id: number; p_rows: ImportProposalRow[]; p_final: boolean }, { upserted: number; reopened: number; staled: number }];
  import_finish: [{ p_run_id: number; p_counts: ImportCounts }, ImportRun];
  import_abort: [{ p_run_id: number; p_reason: string }, ImportRun];
  import_crm_work: [{ p_key_hashes: string[] }, string[]];
  import_runs: [Record<string, never>, ImportRun[]];
  import_changes: [{ p_run_id: number; p_change: ImportChangeRow['change']; p_only_crm: boolean; p_offset: number; p_limit: number }, ImportChangeRow[]];

  export_begin: [{ p_target: BulkTarget; p_format: ExportFormat; p_options: ExportOptions }, { exportId: number; total: number }];
  export_page: [{ p_export_id: number; p_offset: number; p_limit: number }, ExportRow[]];
  backup_export: [{ p_table: BackupTable; p_offset: number; p_limit: number }, Record<string, unknown>[]];
  backup_restore: [{ p_table: BackupTable; p_rows: Record<string, unknown>[] }, { inserted: number; skipped: number; unresolved: number }];

  members_list: [Record<string, never>, TeamMember[]];
  member_upsert: [{ p_member: Partial<TeamMember> & Pick<TeamMember, 'email' | 'role' | 'displayName'> }, TeamMember];
  settings_get: [Record<string, never>, { settings: PublicSettings; params: ValidationParams }];
  setting_set: [{ p_key: string; p_value: unknown }, { ok: true }];
  status_upsert: [{ p_status: Partial<LeadStatus> & Pick<LeadStatus, 'name'> }, LeadStatus];
  status_delete: [{ p_id: number; p_reassign_to: number }, { reassigned: number }];
  tag_upsert: [{ p_tag: Partial<Tag> & Pick<Tag, 'name'> }, Tag];
  tag_delete: [{ p_id: number }, { deleted: true }];
  generic_domain_upsert: [{ p_domain: string; p_kind: ValDecisions['genericDomains'][number]['kind'] | null; p_suggestion: string | null }, { ok: true }];
  db_usage: [Record<string, never>, DbUsage];
}
export type RpcName = keyof Rpc;
export type RpcArgs<N extends RpcName> = Rpc[N][0];
export type RpcResult<N extends RpcName> = Rpc[N][1];

/** RPCs a member may call; everything else is owner-only (enforced in SQL, mirrored in the UI). */
export const MEMBER_RPCS: readonly RpcName[] = [
  'me', 'ref_data', 'dict', 'leads_search', 'leads_count', 'leads_facets', 'lead_get', 'lead_timeline', 'lead_update',
  'leads_bulk', 'activity_add', 'activity_update', 'activity_delete', 'contact_upsert', 'contact_delete', 'tasks_list',
  'task_upsert', 'task_done', 'task_delete', 'today', 'templates_list', 'template_upsert', 'template_delete', 'lists_list',
  'list_upsert', 'list_delete', 'views_list', 'view_upsert', 'view_delete', 'val_summary', 'val_queue', 'val_proposal_get',
  'val_decide', 'val_account_link', 'networks_list', 'network_upsert', 'network_member_remove', 'tag_upsert',
];
