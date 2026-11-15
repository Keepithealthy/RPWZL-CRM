import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ENTITY_TYPE_PL, PROPOSAL_KIND_PL, PROPOSAL_STATUS, type LeadCard } from '../../lib/contract';
import { errorText, rpc } from '../../lib/api';
import { statusName, useRefData } from '../../lib/queries';
import { Badge, Empty } from '../../components/common';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/common';
import { useUi } from '../../components/ui';
import { invalidateLead } from './hooks';

const STATUS_PL: Record<number, string> = { [PROPOSAL_STATUS.OPEN]: 'otwarta', [PROPOSAL_STATUS.ACCEPTED]: 'zaakceptowana', [PROPOSAL_STATUS.REJECTED]: 'odrzucona', [PROPOSAL_STATUS.STALE]: 'nieaktualna' };

export function RelatedTab({ card }: { card: LeadCard }) {
  const ref = useRefData().data ?? null;
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const [attach, setAttach] = useState(false);
  const id = card.row.id;

  const link = useMutation({
    mutationFn: (v: { action: 'detach' | 'attach'; key: string | null }) => rpc('val_account_link', { p_entry_id: id, p_action: v.action, p_account_key: v.key, p_note: null }),
    onSuccess: () => { toast('Zapisano decyzję o koncie'); invalidateLead(qc); },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const rmNet = useMutation({
    mutationFn: () => rpc('network_member_remove', { p_network_id: card.network!.id, p_account_key: card.row.accountKey }),
    onSuccess: () => { toast('Usunięto z sieci'); invalidateLead(qc, id); },
    onError: (e) => toast(errorText(e), 'error'),
  });

  return (
    <div className="related">
      <section>
        <h3>To samo konto (ten sam NIP)</h3>
        {card.account.length === 0 ? <p className="muted">Ten wpis jest jedynym wpisem swojego konta.</p> : (
          <div className="table-wrap">
          <table className="grid small">
            <thead><tr><th>Nazwa</th><th>Typ</th><th>NIP</th><th>Status</th><th>W rejestrze</th></tr></thead>
            <tbody>
              {card.account.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/lead/${r.id}`}>{r.name ?? '(bez nazwy)'}</Link></td>
                  <td>{ENTITY_TYPE_PL[r.entityType]}</td><td>{r.nip ?? '–'}</td><td>{statusName(ref, r.statusId)}</td><td>{r.inRegister ? 'tak' : 'nie'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        <div className="btnrow">
          {card.account.length > 0 ? <button type="button" className="btn btn-sm" onClick={async () => { if (await confirm('Odłączyć ten wpis od konta? Zostanie osobnym kontem, a decyzja zostanie zapamiętana przy kolejnych importach.', { confirmLabel: 'Odłącz' })) link.mutate({ action: 'detach', key: null }); }}>Odłącz od konta</button> : null}
          <button type="button" className="btn btn-sm" onClick={() => setAttach(true)}>Dołącz do konta…</button>
        </div>
      </section>

      <section>
        <h3>Sieć</h3>
        {card.network ? (
          <p>{card.network.name} — {card.network.members} kont w sieci. <button type="button" className="link" onClick={async () => { if (await confirm('Usunąć to konto z sieci?', { confirmLabel: 'Usuń z sieci' })) rmNet.mutate(); }}>Usuń z sieci</button></p>
        ) : <p className="muted">To konto nie należy do żadnej sieci. Sieci tworzysz w ekranie Walidacja, potwierdzając propozycję.</p>}
      </section>

      <section>
        <h3>Propozycje walidacji</h3>
        {card.proposals.length === 0 ? <p className="muted">Brak propozycji dotyczących tego konta.</p> : (
          <ul>
            {card.proposals.map((p) => (
              <li key={p.id}>{PROPOSAL_KIND_PL[p.kind]} · pewność {p.confidence} · <Badge tone={p.status === PROPOSAL_STATUS.OPEN ? 'yellow' : 'gray'}>{STATUS_PL[p.status]}</Badge> <Link to="/walidacja">Otwórz w Walidacji</Link></li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Na listach</h3>
        {card.lists.length === 0 ? <Empty title="Lead nie jest na żadnej liście.">Dodasz go z ekranu Leady (akcja zbiorcza „Dodaj do listy”).</Empty> : <ul>{card.lists.map((l) => <li key={l.id}>{l.name}</li>)}</ul>}
      </section>

      {attach ? <AttachDialog onClose={() => setAttach(false)} onAttach={(key) => link.mutate({ action: 'attach', key }, { onSuccess: () => setAttach(false) })} /> : null}
    </div>
  );
}

function AttachDialog({ onClose, onAttach }: { onClose: () => void; onAttach: (key: string) => void }) {
  const [nip, setNip] = useState('');
  const digits = nip.replace(/\D/g, '');
  return (
    <Modal title="Dołącz do konta" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Anuluj</button><button type="button" className="btn btn-primary" disabled={digits.length !== 10} onClick={() => onAttach(`n:${digits}`)}>Dołącz</button></>}>
      <p>Wpisz NIP konta, do którego ten wpis należy (10 cyfr).</p>
      <Field label="NIP konta"><input value={nip} onChange={(e) => setNip(e.target.value)} inputMode="numeric" autoFocus /></Field>
    </Modal>
  );
}
