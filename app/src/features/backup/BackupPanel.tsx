import { useRef, useState } from 'react';
import { BackupFormatError, BACKUP_TABLE_PL, buildBackup, parseBackup, restoreBackup, type RestoreReport } from '../../lib/backup';
import { errorText } from '../../lib/api';
import { downloadBlob, gzipText, readMaybeGzip } from '../../lib/download';
import { daysSince, fmtDate, fmtNum, todayIso } from '../../lib/format';
import { readPref, writePref } from '../../lib/prefs';
import { useUi } from '../../components/ui';

export function BackupPanel() {
  const { toast, confirm } = useUi();
  const [last, setLast] = useState<string | null>(() => readPref<string | null>('backup.last', null));
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<RestoreReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const age = daysSince(last);

  async function download() {
    setBusy('Przygotowuję kopię…'); setError(null);
    try {
      const file = await buildBackup((p) => setBusy(`Pobieram: ${BACKUP_TABLE_PL[p.table]} (${p.tableIndex + 1}/${p.tableCount}, ${fmtNum(p.rows)} wierszy)…`));
      const blob = await gzipText(JSON.stringify(file));
      const date = todayIso();
      downloadBlob(blob, `crm-kopia-${date}.json.gz`);
      writePref('backup.last', date);
      setLast(date);
      toast('Kopia danych CRM została pobrana');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function restore(file: File) {
    setError(null); setReport(null);
    try {
      const parsed = parseBackup(await readMaybeGzip(file));
      const ok = await confirm('Przywrócić dane z kopii? Rekordy, które już istnieją, zostaną pominięte (nic nie jest nadpisywane). Najpierw zaimportuj rejestr, inaczej leady nie znajdą swoich wpisów.', { confirmLabel: 'Przywróć' });
      if (!ok) return;
      setBusy('Przywracam…');
      setReport(await restoreBackup(parsed, (p) => setBusy(`Przywracam: ${BACKUP_TABLE_PL[p.table]} (${p.done}/${p.total})…`)));
      toast('Przywracanie zakończone');
    } catch (e) {
      setError(e instanceof BackupFormatError ? e.message : errorText(e));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <section className="panel" aria-labelledby="backup-h">
      <h2 id="backup-h">Kopia danych CRM</h2>
      <p>Darmowy plan bazy nie robi kopii zapasowych. Ten plik zawiera wszystko, co Wy wpisaliście: statusy, opiekunów, notatki, historię kontaktów, zadania, szablony, listy, widoki i decyzje walidacji. Nie zawiera danych z rejestru (te wczytasz ponownie z pliku indeksu).</p>
      <p className="hint">Plik zawiera dane osobowe: przechowuj go bezpiecznie (np. na firmowym dysku), nie wysyłaj go e-mailem.</p>
      {last ? <p>Ostatnia kopia pobrana: <strong>{fmtDate(last)}</strong>{age !== null && age > 30 ? <span className="overdue"> — minęło ponad 30 dni, pobierz nową.</span> : null}</p> : <p className="overdue">Kopia nie była jeszcze pobrana z tej przeglądarki.</p>}
      <div className="btnrow">
        <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void download()}>Pobierz kopię danych CRM</button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => fileRef.current?.click()}>Przywróć z kopii…</button>
        <input ref={fileRef} type="file" accept=".gz,.json,application/gzip,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void restore(f); }} />
      </div>
      {busy ? <p className="muted" role="status">{busy}</p> : null}
      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
      {report ? (
        <table className="grid small"><caption>Wynik przywracania</caption>
          <thead><tr><th>Tabela</th><th>Dodano</th><th>Pominięto (już były)</th><th>Bez wpisu w rejestrze</th></tr></thead>
          <tbody>{report.perTable.map((r) => <tr key={r.table}><td>{BACKUP_TABLE_PL[r.table]}</td><td>{fmtNum(r.inserted)}</td><td>{fmtNum(r.skipped)}</td><td>{fmtNum(r.unresolved)}</td></tr>)}</tbody>
        </table>
      ) : null}
    </section>
  );
}
