import { ERROR_TEXT_PL } from '../../lib/contract';

/** What the import screen shows after a failed import (UX-R3-2). */
export interface ImportFailure {
  /** Polish text for the owner */
  message: string;
  /** technical detail for the CRM administrator (shown on its own line), or null */
  detail: string | null;
  /** true when choosing the same file again can help ("Wybierz plik jeszcze raz" is then the primary action) */
  retry: boolean;
}

const fieldOf = (e: unknown, k: string): string => {
  if (!e || typeof e !== 'object' || !(k in e)) return '';
  const v = (e as Record<string, unknown>)[k];
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
};

const CRM_DATA_SAFE = 'Statusy, notatki, zadania i decyzje zespołu są nienaruszone.';

/**
 * Failure text by error code. CR422 / CR413: the database refused the file's data (or the dictionary / database is full),
 * so the same file will fail again: no form or selection advice, the database detail goes to `detail`. A dedicated key text
 * (dictionary_full, database_full) already says what to do and gets no extra trailer. CR423: another import holds the lock and
 * nothing was written. Anything else: the import can be resumed with the same file.
 */
export function importFailure(e: unknown, fallback: string): ImportFailure {
  const code = fieldOf(e, 'code');
  const messagePl = fieldOf(e, 'messagePl') || fallback;
  const raw = fieldOf(e, 'detail').trim();
  const detail = raw ? `${code ? code + ': ' : ''}${raw.slice(0, 300)}` : null;
  if (code === 'CR422' || code === 'CR413') {
    const keyText = messagePl !== ERROR_TEXT_PL[code as 'CR422' | 'CR413'] ? messagePl : null;
    if (keyText) return { message: `${keyText} ${CRM_DATA_SAFE}`, detail, retry: false };
    return {
      message: `Baza danych odrzuciła dane z tego pliku, więc import się zatrzymał. ${CRM_DATA_SAFE} Ponowienie z tym samym plikiem nie pomoże — przekaż szczegóły poniżej administratorowi CRM.`,
      detail: detail ?? code,
      retry: false,
    };
  }
  if (code === 'CR423') {
    return { message: `${ERROR_TEXT_PL.CR423} Nic nie zostało zapisane. Spróbuj ponownie za kilka minut.`, detail: null, retry: true };
  }
  return { message: `${messagePl} Import został wycofany do bezpiecznego stanu. Wybierz ten sam plik jeszcze raz — zostaną wysłane tylko brakujące wpisy.`, detail: null, retry: true };
}
