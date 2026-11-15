import { forwardRef } from 'react';
import { Link } from 'react-router-dom';
import { ENTITY_TYPE, ENTITY_TYPE_PL, PROPOSAL_STATUS, QFLAG, type LeadRow } from '../../lib/contract';
import { fmtDateTime, plural } from '../../lib/format';
import { Badge } from '../../components/common';
import { accountCheckReason, confidenceTone, describeProposal, entriesByAccount, splitEntries, type ProposalGroup } from './grouping';
import { useProposalDetail, useDetach, type QueueName } from './hooks';
import { qflagLabels } from './rules';

const NIP_MASK = QFLAG.NIP_MISSING | QFLAG.NIP_BAD_FORMAT | QFLAG.NIP_PLACEHOLDER | QFLAG.NIP_CHECKSUM;

/** E-mail and phone on separate lines; a dash only when both are missing (UX-R4-4). */
function contactLines(e: LeadRow): React.ReactNode {
  const lines = [e.email, e.tel].filter((x): x is string => Boolean(x));
  if (lines.length === 0) return '–';
  return lines.map((x, i) => <span key={i}>{i > 0 ? <br /> : null}{x}</span>);
}

function EntryRow({ e, canSplit, onSplit, busy }: { e: LeadRow; canSplit: boolean; onSplit: (e: LeadRow) => void; busy: boolean }) {
  const nipProblems = qflagLabels(e.qflags, NIP_MASK);
  return (
    <tr>
      <td><Link to={`/lead/${e.id}`} target="_blank" rel="noreferrer">{e.name ?? '(bez nazwy)'}</Link>{!e.inRegister ? <> <Badge tone="yellow">zniknął z rejestru</Badge></> : null}</td>
      <td>{ENTITY_TYPE_PL[e.entityType]}</td>
      <td className="nowrap">{e.nip ?? '–'}{nipProblems.length ? <> <Badge tone="red" title={nipProblems.join(', ')}>NIP?</Badge></> : null}</td>
      <td>{[e.miasto, e.woj].filter(Boolean).join(', ') || '–'}</td>
      <td>{contactLines(e)}</td>
      <td>{canSplit ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onSplit(e)}>Rozdziel ten wpis</button> : null}</td>
    </tr>
  );
}

interface Props {
  group: ProposalGroup;
  queue: QueueName;
  active: boolean;
  skipped: boolean;
  onActivate: () => void;
  onAccept: () => void;
  onReject: () => void;
  onLater: () => void;
  onReopen: () => void;
  busy: boolean;
}

/**
 * Why a 'person' card needs a closer look (VAL-R3-2, VAL-R3-5): a member account holds a company / public body next to practices
 * or is flagged "do sprawdzenia" (the database refuses the merge until it is split), or the import gave it a low confidence
 * because the holders' names differ.
 */
function personCheck(accounts: ReadonlyArray<{ entries: readonly LeadRow[] }>, confidence: number): string | null {
  const mixed = accounts.some((a) =>
    a.entries.some((e) => (e.qflags & QFLAG.ACCOUNT_CHECK) !== 0)
    || (a.entries.some((e) => e.entityType === ENTITY_TYPE.PODMIOT_PRAWNY || e.entityType === ENTITY_TYPE.PUBLICZNY)
      && a.entries.some((e) => e.entityType === ENTITY_TYPE.PRAKTYKA_IND || e.entityType === ENTITY_TYPE.PRAKTYKA_GRUP)));
  if (mixed) return 'Najpierw rozdziel konto: jedno z tych kont ma też wpisy firmy lub innych osób (ten sam NIP). Użyj „Rozdziel ten wpis” albo propozycji „ten sam NIP”, a potem wróć do tej karty.';
  if (confidence < 90) return 'Ten sam numer prawa wykonywania zawodu, ale inne imię lub nazwisko — sprawdź, czy to na pewno ta sama osoba (możliwa literówka w rejestrze).';
  return null;
}

/** One proposal (or several with identical members): reasons, confidence, entries side by side, decision buttons. */
export const ProposalCard = forwardRef<HTMLElement, Props>(function ProposalCard({ group, queue, active, skipped, onActivate, onAccept, onReject, onLater, onReopen, busy }, ref) {
  const first = group.proposals[0];
  const open = group.proposals.every((p) => p.status === PROPOSAL_STATUS.OPEN);
  const stale = group.proposals.every((p) => p.status === PROPOSAL_STATUS.STALE);
  const detail = useProposalDetail(active || !open ? (first?.id ?? null) : null);
  const detach = useDetach();
  const entries = detail.data?.entries ?? [];
  const accounts = entriesByAccount(entries, group.members);
  const acceptLabel = queue === 'networks' ? 'Potwierdź sieć' : 'To ten sam podmiot';
  const rejectLabel = queue === 'networks' ? 'To nie jest sieć' : 'To różne podmioty';
  const isCheck = first?.kind === 'account_check' && entries.length > 0;
  const splitHint = isCheck ? splitEntries(entries, detail.data?.detachIds) : [];
  const checkReason = isCheck ? accountCheckReason(entries) : null;
  const mergeHint = first && (first.kind === 'person' || first.kind === 'reg_duplicate') && group.members.length > 1;
  const personWarning = first?.kind === 'person' ? personCheck(accounts, group.confidence) : null;
  const decided = group.proposals.some((p) => p.decidedAt) && !open;
  const statusLabel = first?.status === PROPOSAL_STATUS.ACCEPTED ? 'potwierdzone' : first?.status === PROPOSAL_STATUS.REJECTED ? 'odrzucone' : stale ? 'nieaktualne' : null;
  const summary = entries[0]?.name ?? null;
  const title = summary ?? (group.proposals.length > 1 ? `${group.proposals.length} powody` : describeProposal(first!.kind, first!.matchValue));
  // a single reason that is already the title is not repeated as a bullet (UX-R4-4)
  const showReasons = !(group.proposals.length === 1 && first && title === describeProposal(first.kind, first.matchValue));

  return (
    <article
      ref={ref as React.Ref<HTMLElement>}
      className={`val-card${active ? ' active' : ''}${skipped ? ' skipped' : ''}${open ? '' : ' decided'}`}
      aria-label={`Propozycja: ${group.proposals.map((p) => describeProposal(p.kind, p.matchValue)).join('; ')}`}
      onClick={onActivate}
    >
      <div className="val-head">
        <strong>{title}</strong>
        <span>
          <Badge tone={confidenceTone(group.confidence)} title="Pewność to szacunek maszyny (0–100). Powyżej 80 zwykle wystarczy szybki rzut oka.">pewność {group.confidence}</Badge>{' '}
          <Badge>{group.members.length} {plural(group.members.length, 'konto', 'konta', 'kont')}</Badge>
          {skipped ? <> <Badge tone="yellow">później</Badge></> : null}
          {statusLabel ? <> <Badge tone={first?.status === PROPOSAL_STATUS.ACCEPTED ? 'green' : 'gray'}>{statusLabel}</Badge></> : null}
          {group.newMembers.length > 0 ? <> <span className="val-new">Nowe od ostatniej decyzji: {group.newMembers.length}</span></> : null}
        </span>
      </div>
      {showReasons ? (
        <ul className="val-reasonlist">
          {group.proposals.map((p) => <li key={p.id}>{describeProposal(p.kind, p.matchValue)}{p.kind === 'account_check' && checkReason ? ` — ${checkReason}` : ''} <span className="muted">(pewność {p.confidence})</span></li>)}
        </ul>
      ) : null}

      {active || !open ? (
        detail.isLoading ? <p className="muted" role="status">Wczytywanie wpisów…</p> : detail.isError ? <p className="alert alert-error" role="alert">Nie udało się wczytać wpisów tej propozycji.</p> : (
          <div className="val-accounts">
            {accounts.map((a, i) => (
              <section key={a.key} className="val-account" aria-label={`Konto ${i + 1}`}>
                <h4>Konto {i + 1} · wpisów: {a.entries.length}{group.newMembers.includes(a.key) ? ' · nowe od ostatniej decyzji' : ''}</h4>
                <table>
                  <colgroup><col className="vc-name" /><col className="vc-type" /><col className="vc-nip" /><col className="vc-addr" /><col className="vc-contact" /><col className="vc-act" /></colgroup>
                  <thead><tr><th>Nazwa</th><th>Typ</th><th>NIP</th><th>Adres</th><th>Kontakt</th><th /></tr></thead>
                  <tbody>
                    {a.entries.map((e) => (
                      <EntryRow key={e.id} e={e} busy={detach.isPending} canSplit={queue === 'accounts' && open && a.entries.length > 1} onSplit={(x) => detach.mutate(x)} />
                    ))}
                  </tbody>
                </table>
              </section>
            ))}
          </div>
        )
      ) : <p className="muted">Zaznacz kartę (kliknij lub użyj klawiszy J / K), aby zobaczyć wpisy obok siebie.</p>}

      {open ? (
        <div className="val-actions">
          <button type="button" className="btn btn-primary" disabled={busy} aria-keyshortcuts="T" onClick={(e) => { e.stopPropagation(); onAccept(); }}>{acceptLabel} <kbd className="val-kbd">T</kbd></button>
          <button type="button" className="btn" disabled={busy} aria-keyshortcuts="N" onClick={(e) => { e.stopPropagation(); onReject(); }}>{rejectLabel} <kbd className="val-kbd">N</kbd></button>
          <button type="button" className="btn" disabled={busy} aria-keyshortcuts="L" onClick={(e) => { e.stopPropagation(); onLater(); }}>Później <kbd className="val-kbd">L</kbd></button>
        </div>
      ) : (
        <div className="val-actions">
          {decided ? <span className="muted">Decyzja: {fmtDateTime(first?.decidedAt)}{first?.note ? ` — ${first.note}` : ''}</span> : null}
          <button type="button" className="btn btn-sm" disabled={busy} onClick={(e) => { e.stopPropagation(); onReopen(); }}>Cofnij decyzję</button>
        </div>
      )}
      {open && splitHint.length > 0 ? <p className="val-note">„{rejectLabel}” rozdzieli konto: {splitHint.length === 1 ? 'wpis' : 'wpisy'} „{splitHint.map((e) => e.name ?? '(bez nazwy)').join('”, „')}” {splitHint.length === 1 ? 'dostanie' : 'dostaną'} własne konto.</p> : null}
      {open && isCheck && splitHint.length === 0 && detail.data?.detachIds ? (
        <p className="val-note val-warn" role="note">„{rejectLabel}” niczego tu nie rozdzieli: reguła uznaje te wpisy za jedną osobę (np. zmiana nazwiska). Jeśli to jednak różne osoby, użyj „Rozdziel ten wpis” przy wpisie innej osoby.</p>
      ) : null}
      {open && personWarning ? <p className="val-note val-warn" role="note">{personWarning}</p> : null}
      {open && mergeHint ? (
        <p className="val-note">{first?.kind === 'person'
          ? `„${acceptLabel}” przeniesie praktyki tej osoby (z tym numerem prawa wykonywania zawodu) do jednego konta — najlepiej do konta z poprawnym NIP. Inne wpisy zostają na swoich kontach (możesz to później cofnąć przyciskiem „Rozdziel ten wpis”).`
          : `„${acceptLabel}” połączy te konta w jedno (możesz to później cofnąć przyciskiem „Rozdziel ten wpis”).`}</p>
      ) : null}
    </article>
  );
});
