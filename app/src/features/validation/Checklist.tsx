/**
 * Validation status and the "Lista kontrolna po rozmowie" (SPEC 6.7). Exported for the record card (APP builder):
 *   ValidationStatusBadge  - status pill, italic when derived by the system
 *   ValidationReasons      - why the system wants a human to look (from qflags)
 *   ChecklistForm          - controlled form: checklist + status + note, with the suggested status
 *   ChecklistEditor        - the form plus "Zapisz" (api.lead_update), ready to drop into a dialog or a tab
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  QFLAG_PROBLEM_MASK, VALIDATION, VALIDATION_PL, type LeadPatch, type LeadRow, type ValidationChecklist, type ValidationStatus,
} from '../../lib/contract';
import { errorText, rpc } from '../../lib/api';
import { Badge, Field } from '../../components/common';
import { qflagLabels } from './rules';

const TONE: Record<ValidationStatus, 'gray' | 'yellow' | 'green' | 'red'> = { 0: 'gray', 1: 'yellow', 2: 'green', 3: 'red' };

export function ValidationStatusBadge({ status, derived = false, title }: { status: ValidationStatus; derived?: boolean; title?: string }) {
  return (
    <Badge tone={TONE[status]} title={title ?? (derived ? 'Status nadany automatycznie przez system. Zmieni się po Twojej decyzji.' : 'Status nadany przez zespół.')}>
      {derived ? <em>{VALIDATION_PL[status]}</em> : VALIDATION_PL[status]}
    </Badge>
  );
}

/** Problems (from `qflags`) that make the system ask for a human check; empty when there is nothing to report. */
export function validationReasons(qflags: number): string[] {
  return qflagLabels(qflags, QFLAG_PROBLEM_MASK);
}

export function ValidationReasons({ qflags }: { qflags: number }) {
  const reasons = validationReasons(qflags);
  if (reasons.length === 0) return null;
  return (
    <ul className="val-reasons" aria-label="Dlaczego wpis jest do sprawdzenia">
      {reasons.map((r) => <li key={r}>{r}</li>)}
    </ul>
  );
}

/** All of the first three ticked suggests "Zweryfikowany"; "Podmiot nie istnieje" suggests "Odrzucony". */
export function suggestStatus(c: ValidationChecklist | null | undefined): ValidationStatus | null {
  if (!c) return null;
  if (c.podmiotDziala === false) return VALIDATION.ODRZUCONY;
  if (c.podmiotDziala === true && c.profilPasuje === true && c.telefonOk === true) return VALIDATION.ZWERYFIKOWANY;
  return null;
}

type Tri = boolean | null | undefined;
const triValue = (v: Tri) => (v === true ? 'tak' : v === false ? 'nie' : '');
const fromTri = (s: string): boolean | null => (s === 'tak' ? true : s === 'nie' ? false : null);

export interface ChecklistState {
  checklist: ValidationChecklist;
  /** null = automatic (derived by the system) */
  status: ValidationStatus | null;
  note: string;
}

export function ChecklistForm({ value, onChange, disabled }: { value: ChecklistState; onChange: (next: ChecklistState) => void; disabled?: boolean }) {
  const c = value.checklist;
  const set = (patch: Partial<ValidationChecklist>) => onChange({ ...value, checklist: { ...c, ...patch } });
  const suggestion = suggestStatus(c);
  const tri = (key: 'podmiotDziala' | 'profilPasuje' | 'telefonOk' | 'emailOk' | 'wwwOk', label: string) => (
    <Field label={label} key={key}>
      <select disabled={disabled} value={triValue(c[key])} onChange={(e) => set({ [key]: fromTri(e.target.value) })}>
        <option value="">nie sprawdzono</option><option value="tak">tak</option><option value="nie">nie</option>
      </select>
    </Field>
  );
  return (
    <div className="val-checklist">
      <p className="hint">Wypełnij po rozmowie. Ustalasz tu, czy ten wpis to prawdziwy, działający podmiot, który nas interesuje.</p>
      {tri('podmiotDziala', 'Podmiot istnieje i działa pod tym adresem')}
      {tri('profilPasuje', 'Profil pasuje do naszej oferty')}
      {tri('telefonOk', 'Telefon działa i należy do tego podmiotu')}
      {tri('emailOk', 'E-mail potwierdzony')}
      {tri('wwwOk', 'Strona WWW aktualna')}
      <Field label="Osoba decyzyjna (imię, stanowisko)">
        <input disabled={disabled} maxLength={200} value={c.decydent ?? ''} onChange={(e) => set({ decydent: e.target.value || null })} />
      </Field>
      <Field label="Należy do sieci / grupy">
        <select disabled={disabled} value={c.siec ?? ''} onChange={(e) => set({ siec: (e.target.value || null) as ValidationChecklist['siec'] })}>
          <option value="">nie sprawdzono</option><option value="tak">tak</option><option value="nie">nie</option><option value="nie_wiem">nie wiem</option>
        </select>
      </Field>
      <Field label="Uwagi">
        <textarea disabled={disabled} rows={3} maxLength={2000} value={c.uwagi ?? ''} onChange={(e) => set({ uwagi: e.target.value || null })} />
      </Field>
      <Field label="Status walidacji">
        <select
          disabled={disabled}
          value={value.status === null ? 'auto' : String(value.status)}
          onChange={(e) => onChange({ ...value, status: e.target.value === 'auto' ? null : (Number(e.target.value) as ValidationStatus) })}
        >
          <option value="auto">Automatyczny (decyduje system)</option>
          {(Object.entries(VALIDATION_PL) as Array<[string, string]>).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </Field>
      {suggestion !== null && value.status !== suggestion ? (
        <p className="alert alert-warn" role="status">
          <span>Na podstawie listy kontrolnej proponujemy status „{VALIDATION_PL[suggestion]}”.</span>
          <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => onChange({ ...value, status: suggestion })}>Ustaw</button>
        </p>
      ) : null}
      <Field label="Notatka do statusu">
        <input disabled={disabled} maxLength={300} value={value.note} onChange={(e) => onChange({ ...value, note: e.target.value })} />
      </Field>
    </div>
  );
}

/** Initial editor state from a card's lead data (`LeadCard.lead` / `LeadCard.row`). */
export function checklistStateFrom(row: Pick<LeadRow, 'validation' | 'validationIsDerived'>, lead: { checklist: ValidationChecklist | null; validationNote: string | null } | null): ChecklistState {
  return { checklist: lead?.checklist ?? {}, status: row.validationIsDerived ? null : row.validation, note: lead?.validationNote ?? '' };
}

/** Form + save button. `version` is `LeadRow.version` (optimistic lock). Calls `onSaved` with the updated row. */
export function ChecklistEditor({ entryId, version, initial, onSaved }: { entryId: number; version: number; initial: ChecklistState; onSaved?: (row: LeadRow) => void }) {
  const qc = useQueryClient();
  const [state, setState] = useState<ChecklistState>(initial);
  const save = useMutation({
    mutationFn: () => {
      const patch: LeadPatch = { checklist: state.checklist, validation: state.status, validationNote: state.note.trim() || null };
      return rpc('lead_update', { p_entry_id: entryId, p_version: version, p_patch: patch });
    },
    onSuccess: (row) => {
      void qc.invalidateQueries({ queryKey: ['lead', entryId] });
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['val'] });
      void qc.invalidateQueries({ queryKey: ['timeline'] });
      onSaved?.(row);
    },
  });
  return (
    <div>
      <ChecklistForm value={state} onChange={setState} disabled={save.isPending} />
      {save.isError ? <p className="alert alert-error" role="alert">{errorText(save.error)}</p> : null}
      <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>Zapisz walidację</button>
    </div>
  );
}
