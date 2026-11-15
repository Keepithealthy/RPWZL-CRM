import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { VALIDATION, ENTITY_TYPE_PL, type LeadFilter } from '../../lib/contract';
import { rpc } from '../../lib/api';
import { Badge, Empty, ErrorBox, Pager, Spinner } from '../../components/common';
import { ValidationReasons, validationReasons } from './Checklist';

const PAGE = 25;

/** Third queue: leads whose effective validation status is "Do sprawdzenia" (`leads_search` with `validation: [1]`). */
export function RecordsQueue({ segment }: { segment: LeadFilter | null }) {
  const [page, setPage] = useState(0);
  const filter: LeadFilter = { ...(segment ?? {}), validation: [VALIDATION.DO_SPRAWDZENIA] };
  const count = useQuery({ queryKey: ['val', 'records', 'count', filter], queryFn: () => rpc('leads_count', { p_filter: filter }), placeholderData: keepPreviousData });
  const rows = useQuery({
    queryKey: ['val', 'records', 'rows', filter, page],
    queryFn: () => rpc('leads_search', { p_filter: filter, p_sort: null, p_offset: page * PAGE, p_limit: PAGE }),
    placeholderData: keepPreviousData,
  });
  if (rows.isLoading) return <Spinner />;
  if (rows.isError) return <ErrorBox error={rows.error} onRetry={() => void rows.refetch()} />;
  const list = rows.data?.rows ?? [];
  if (list.length === 0) return <Empty title="Brak rekordów do sprawdzenia.">Wszystkie wpisy w tym widoku są zweryfikowane albo bez zastrzeżeń.</Empty>;
  return (
    <div>
      <p className="hint">Te wpisy mają problemy, które system potrafi wykryć (zły NIP, brak kontaktu, możliwa literówka w e-mailu…). Otwórz kartę, sprawdź dane telefonicznie i wypełnij listę kontrolną.</p>
      <div className="table-wrap">
        <table className="grid small">
          <caption className="sr-only">Rekordy do sprawdzenia</caption>
          <thead><tr><th>Nazwa</th><th>Typ</th><th>Miasto</th><th>Kontakt</th><th>Co jest nie tak</th></tr></thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/lead/${r.id}?tab=kontakt`}>{r.name ?? '(bez nazwy)'}</Link></td>
                <td>{ENTITY_TYPE_PL[r.entityType]}</td>
                <td>{r.miasto ?? '–'}</td>
                <td>{r.email ?? '–'}<br />{r.tel ?? ''}</td>
                <td>
                  {validationReasons(r.qflags).length > 0
                    ? <ValidationReasons qflags={r.qflags} />
                    : <Badge title="Konto tego wpisu jest w otwartej propozycji w zakładkach „Konta” albo „Sieci i duplikaty”.">w propozycji walidacji (sieć / duplikat)</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} pageSize={PAGE} total={count.data?.total ?? list.length} onPage={setPage} />
    </div>
  );
}
