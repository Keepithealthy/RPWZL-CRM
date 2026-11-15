import { useRef, useState } from 'react';
import type { BulkTarget, ExportFormat, ExportOptions } from '../../lib/contract';
import { errorText } from '../../lib/api';
import { BOM, CSV_COLUMNS, CSV_DEFAULT_OPTIONAL, buildCustomerioCsv, buildGenericCsv, dedupeRows, exportFileName, prepareCustomerio } from '../../lib/csv';
import { downloadText } from '../../lib/download';
import { fmtNum, leadsPl, todayIso } from '../../lib/format';
import { Modal } from '../../components/Modal';
import { countDnc, fetchExportRows } from './run';

interface Props { target: BulkTarget; count: number; label: string; onClose: () => void }

interface Result { text: string; fileName: string; bom: boolean; rows: number; skipped: string[]; mime: string }

export default function ExportDialog({ target, count, label, onClose }: Props) {
  const [format, setFormat] = useState<ExportFormat>('customerio');
  const [includeDnc, setIncludeDnc] = useState(false);
  // csv
  const [dedupeNip, setDedupeNip] = useState(true);
  const [dedupeEmail, setDedupeEmail] = useState(false);
  const [separator, setSeparator] = useState<';' | ','>(';');
  const [bom, setBom] = useState(true);
  const [optional, setOptional] = useState<string[]>(CSV_DEFAULT_OPTIONAL);
  // customer.io
  const [identifier, setIdentifier] = useState<'email' | 'id'>('email');
  const [phoneCol, setPhoneCol] = useState(false);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const cancelled = useRef(false);

  async function prepare() {
    setBusy(true); setError(null); setResult(null); setProgress(null); cancelled.current = false;
    try {
      const dedupe: ExportOptions['dedupe'] = format === 'csv' ? (dedupeEmail ? 'email' : dedupeNip ? 'nip' : 'none') : 'email';
      const options: ExportOptions = { includeDnc, dedupe, requireEmail: format === 'customerio' && identifier === 'email' };
      const [rows, dncSkipped] = await Promise.all([
        fetchExportRows(target, format, options, setProgress, () => cancelled.current),
        includeDnc ? Promise.resolve(0) : countDnc(target).catch(() => 0),
      ]);
      if (cancelled.current) return;
      const skipped: string[] = [];
      if (dncSkipped > 0) skipped.push(`nie kontaktować ${fmtNum(dncSkipped)}`);
      const date = todayIso();
      if (format === 'customerio') {
        const prep = prepareCustomerio(rows, { identifier, includePhoneColumn: phoneCol });
        if (prep.skippedNoEmail) skipped.push(`brak e-maila ${fmtNum(prep.skippedNoEmail)}`);
        if (prep.skippedDuplicates) skipped.push(`duplikaty e-maila ${fmtNum(prep.skippedDuplicates)}`);
        setResult({ text: buildCustomerioCsv(prep.rows, { identifier, includePhoneColumn: phoneCol }), fileName: exportFileName(label, 'csv', date, 'customerio'), bom: false, rows: prep.rows.length, skipped, mime: 'text/csv;charset=utf-8' });
      } else {
        const by = dedupeEmail ? 'email' : dedupeNip ? 'nip' : 'none';
        const d = dedupeRows(rows, by);
        if (d.merged) skipped.push(`duplikaty ${fmtNum(d.merged)}`);
        const text = buildGenericCsv(d.rows, { separator, bom: false, optionalColumns: optional });
        setResult({ text, fileName: exportFileName(label, 'csv', date), bom, rows: d.rows.length, skipped, mime: 'text/csv;charset=utf-8' });
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!result) return;
    downloadText((result.bom ? BOM : '') + result.text, result.fileName, result.mime);
  }

  const toggleOpt = (k: string, on: boolean) => setOptional(on ? [...optional, k] : optional.filter((x) => x !== k));

  return (
    <Modal title="Eksport leadów" wide onClose={() => { cancelled.current = true; onClose(); }} footer={
      <>
        <button type="button" className="btn" onClick={() => { cancelled.current = true; onClose(); }}>Zamknij</button>
        {result ? <button type="button" className="btn btn-primary" onClick={download}>Pobierz plik</button> : <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void prepare()}>{busy ? 'Przygotowuję…' : 'Przygotuj plik'}</button>}
      </>
    }>
      <p>Wybrano: <strong>{leadsPl(count)}</strong>. Plik powstaje w Twojej przeglądarce; serwer zapisuje tylko wpis „kto, kiedy, ile”.</p>
      {count > 50_000 ? <p className="hint" role="note">Duży eksport: przygotowanie pliku z {fmtNum(count)} wpisami może potrwać kilka minut (cały rejestr ok. 2–3 min). Nie zamykaj tej karty w trakcie.</p> : null}
      <fieldset className="checks"><legend>Format</legend>
        <label><input type="radio" checked={format === 'customerio'} onChange={() => { setFormat('customerio'); setResult(null); }} /> Customer.io (plik „People” CSV)</label>
        <label><input type="radio" checked={format === 'csv'} onChange={() => { setFormat('csv'); setResult(null); }} /> CSV (Excel)</label>
      </fieldset>

      {format === 'customerio' ? (
        <>
          <p className="hint">Plik ma stałe kolumny zgodne z importem osób w Customer.io: <code>id</code>, <code>email</code>, <code>created_at</code> i atrybuty (nazwa, miasto, status CRM…). Kodowanie UTF-8 bez BOM, separator przecinek. W Customer.io przy imporcie wskażesz, która kolumna jest identyfikatorem. Ten plik jest przeznaczony do importu w Customer.io, nie do otwierania w Excelu (Excel mógłby potraktować komórki zaczynające się od = + - @ jak formuły). Do Excela użyj formatu „CSV (Excel)”.</p>
          <label className="field"><span className="field-label">Identyfikator osoby</span>
            <select value={identifier} onChange={(e) => { setIdentifier(e.target.value as 'email' | 'id'); setResult(null); }}>
              <option value="email">e-mail (domyślnie; wiersze bez e-maila są pomijane, duplikaty scalane)</option>
              <option value="id">id (każdy lead osobno, także bez e-maila)</option>
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={phoneCol} onChange={(e) => { setPhoneCol(e.target.checked); setResult(null); }} /> Dodaj kolumnę <code>phone</code> (tylko jeśli w Customer.io telefon jest identyfikatorem; inaczej numer jest w <code>sms_phone</code>)</label>
        </>
      ) : (
        <>
          <label className="check"><input type="checkbox" checked={dedupeNip} onChange={(e) => { setDedupeNip(e.target.checked); setResult(null); }} /> Usuń duplikaty po NIP (zostaje wpis z najlepszym kontaktem)</label>
          <label className="check"><input type="checkbox" checked={dedupeEmail} onChange={(e) => { setDedupeEmail(e.target.checked); setResult(null); }} /> Usuń duplikaty po e-mailu</label>
          <div className="row2">
            <label className="field"><span className="field-label">Separator</span>
              <select value={separator} onChange={(e) => { setSeparator(e.target.value as ';' | ','); setResult(null); }}><option value=";">średnik ; (polski Excel)</option><option value=",">przecinek ,</option></select>
            </label>
            <label className="check"><input type="checkbox" checked={bom} onChange={(e) => { setBom(e.target.checked); setResult(null); }} /> UTF-8 z BOM (polskie znaki w Excelu)</label>
          </div>
          <fieldset className="checks cols"><legend>Kolumny (pierwsze pięć zawsze)</legend>
            {CSV_COLUMNS.filter((c) => !c.always).map((c) => (
              <label key={c.key}><input type="checkbox" checked={optional.includes(c.key)} onChange={(e) => { toggleOpt(c.key, e.target.checked); setResult(null); }} /> {c.header}</label>
            ))}
          </fieldset>
          <p className="hint">Komórki zaczynające się od = + - @ dostają apostrof na początku (ochrona przed formułami w arkuszu).</p>
        </>
      )}

      <label className="check"><input type="checkbox" checked={includeDnc} onChange={(e) => { setIncludeDnc(e.target.checked); setResult(null); }} /> Uwzględnij leady oznaczone „nie kontaktować”</label>

      {busy && progress ? <progress max={progress.total} value={progress.done} aria-label="Postęp pobierania">{progress.done}</progress> : null}
      {busy && progress ? <p className="muted">Pobrano {fmtNum(progress.done)} z {fmtNum(progress.total)}…</p> : null}
      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
      {result ? (
        <div className="alert alert-ok" role="status">
          <strong>Plik gotowy: {fmtNum(result.rows)} {result.rows === 1 ? 'wiersz' : 'wierszy'}</strong> ({result.fileName}).
          {result.skipped.length ? <> Pominięto: {result.skipped.join(', ')}.</> : null}
        </div>
      ) : null}
    </Modal>
  );
}
