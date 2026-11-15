/**
 * tel:/sms:/mailto: links and the SMS length counter (SPEC 4.4).
 *
 * NOTE: phone parsing here is the minimal "digits -> 9-digit national number" needed to build a link. Quality
 * labels (mobile / landline / switchboard) come from the database (`mobile`, `qflags`, `phoneOwners`). When
 * features/validation/rules.ts (`parsePhone`) lands, `nationalNumber` should delegate to it (see CONTRACT.md Deviations).
 */

/** 9-digit national number from a raw string, or null when it cannot be reduced to one. */
export function nationalNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('0048')) d = d.slice(4);
  else if (d.length === 11 && d.startsWith('48')) d = d.slice(2);
  return d.length === 9 ? d : null;
}

/** `href` is null when the string does not reduce to a 9-digit national number: such a number is never dialled. */
export interface TelLink { href: string | null; incomplete: boolean }

export function telLink(raw: string): TelLink {
  const nine = nationalNumber(raw);
  if (nine) return { href: `tel:+48${nine}`, incomplete: false };
  return { href: null, incomplete: true };
}

export function smsLink(raw: string, body: string): string | null {
  const nine = nationalNumber(raw);
  return nine ? `sms:+48${nine}?body=${encodeURIComponent(body)}` : null;
}

export const MAILTO_BODY_MAX = 1800;

export interface MailtoResult { href: string; bodyIncluded: boolean }

export function mailtoLink(addr: string, subject: string, body: string): MailtoResult {
  const include = body.length <= MAILTO_BODY_MAX;
  let href = `mailto:${encodeURIComponent(addr).replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}`;
  if (include && body) href += `&body=${encodeURIComponent(body)}`;
  return { href, bodyIncluded: include };
}

const GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€\f';

export interface SmsCount { chars: number; parts: number; unicode: boolean; perPart: number }

/** GSM-7 160/153 per part, UCS-2 70/67 when the text has characters outside GSM-7 (Polish diacritics). */
export function smsCount(text: string): SmsCount {
  let units = 0;
  let unicode = false;
  for (const ch of text) {
    if (GSM7.includes(ch)) units += 1;
    else if (GSM7_EXT.includes(ch)) units += 2;
    else { unicode = true; break; }
  }
  if (unicode) {
    const len = text.length; // UTF-16 code units, as the network counts them
    const parts = len === 0 ? 0 : len <= 70 ? 1 : Math.ceil(len / 67);
    return { chars: len, parts, unicode: true, perPart: len <= 70 ? 70 : 67 };
  }
  const parts = units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153);
  return { chars: units, parts, unicode: false, perPart: units <= 160 ? 160 : 153 };
}

const PL_MAP: Record<string, string> = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z', Ą: 'A', Ć: 'C', Ę: 'E', Ł: 'L', Ń: 'N', Ó: 'O', Ś: 'S', Ź: 'Z', Ż: 'Z' };
export function stripPolish(s: string): string {
  return s.replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, (c) => PL_MAP[c] ?? c);
}

export function smsCounterText(c: SmsCount): string {
  if (c.chars === 0) return '0 znaków';
  const znaki = c.chars === 1 ? 'znak' : c.chars % 10 >= 2 && c.chars % 10 <= 4 && !(c.chars % 100 >= 12 && c.chars % 100 <= 14) ? 'znaki' : 'znaków';
  const sms = c.parts === 1 ? 'SMS' : 'SMS-y';
  return `${c.chars} ${znaki} · ${c.parts} ${sms}${c.unicode ? ' (są polskie znaki)' : ''}`;
}

/** Opens a tel:/sms:/mailto: link through the OS handler. */
export function openExternalLink(href: string): void {
  // An anchor click hands tel:/sms:/mailto: to the OS without unloading the page or touching the history.
  const a = document.createElement('a');
  a.href = href;
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

const MOBILE_PREFIXES = ['45', '50', '51', '53', '57', '60', '66', '69', '72', '73', '78', '79', '88'];
/** Polish mobile ranges (national numbering plan). Used only to decide whether an SMS can reach the number. */
export function isMobileNine(nine: string | null | undefined): boolean {
  return Boolean(nine) && nine!.length === 9 && MOBILE_PREFIXES.some((p) => nine!.startsWith(p));
}
