import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LeadCard, Template } from '../../lib/contract';
import { rpc } from '../../lib/api';
import { MAILTO_BODY_MAX, copyText, mailtoLink, openExternalLink, smsCount, smsCounterText, smsLink, stripPolish, nationalNumber, isMobileNine } from '../../lib/links';
import { buildVars, renderTemplate } from '../../lib/template';
import { useRefData } from '../../lib/queries';
import { useMe } from '../auth/AuthProvider';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/common';
import { useUi } from '../../components/ui';
import { collectEmails, collectPhones, defaultSmsRecipient } from './contacts';
import { MOBILE_SHARED_OWNERS } from '../validation/rules';
import type { OutcomeInitial } from './OutcomeDialog';

interface Props { kind: 'sms' | 'email'; card: LeadCard; initialTo?: string; onClose: () => void; onSent: (initial: OutcomeInitial) => void }

/** SMS / e-mail composer: template -> filled text -> tel/sms/mailto link, then the outcome form (SPEC 4.4). */
export function ComposerDialog({ kind, card, initialTo, onClose, onSent }: Props) {
  const me = useMe();
  const ref = useRefData().data ?? null;
  const { toast } = useUi();
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => rpc('templates_list', {}), staleTime: 60_000 });
  const list = (templates.data ?? []).filter((t) => t.kind === kind && t.active);
  const vars = buildVars(card, me, ref);

  const phones = collectPhones(card).filter((p) => !p.invalid);
  const emails = collectEmails(card).filter((e) => !e.invalid);
  const recipients = kind === 'sms' ? phones.map((p) => p.raw) : emails.map((e) => e.value);
  const [to, setTo] = useState(initialTo ?? (kind === 'sms' ? defaultSmsRecipient(phones, card.row.mobile)?.raw : recipients[0]) ?? '');
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [strip, setStrip] = useState(ref?.settings.smsDiacritics === 'strip');
  const [warn, setWarn] = useState<{ unknown: string[]; empty: string[] }>({ unknown: [], empty: [] });

  const pick = (id: number | null) => {
    setTemplateId(id);
    const t: Template | undefined = list.find((x) => x.id === id);
    if (!t) return;
    const b = renderTemplate(t.body, vars);
    const s = renderTemplate(t.subject ?? '', vars);
    setText(b.text);
    setSubject(s.text);
    setWarn({ unknown: [...new Set([...b.unknown, ...s.unknown])], empty: [...new Set([...b.empty, ...s.empty])] });
  };

  const finalText = kind === 'sms' && strip ? stripPolish(text) : text;
  const nine = nationalNumber(to);
  const landline = kind === 'sms' && to !== '' && !(isMobileNine(nine) || (nine !== null && nine === card.row.mobile));
  const sharedOwners = kind === 'sms' && !landline ? (phones.find((p) => p.raw === to)?.sharedWith ?? 0) : 0;
  const count = smsCount(finalText);
  const mail = kind === 'email' ? mailtoLink(to, subject, text) : null;
  const href = kind === 'sms' ? smsLink(to, finalText) : mail?.href ?? null;

  function open() {
    if (!href) return;
    openExternalLink(href);
    onSent({ type: kind, contactValue: to, subject: kind === 'email' ? subject : null, body: finalText, outcome: 'wyslano', templateId });
  }
  async function copy() {
    const ok = await copyText(kind === 'email' && subject ? `${subject}\n\n${text}` : finalText);
    toast(ok ? 'Skopiowano treść' : 'Nie udało się skopiować', ok ? 'ok' : 'error');
  }

  return (
    <Modal title={kind === 'sms' ? 'SMS do leada' : 'E-mail do leada'} wide onClose={onClose} footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Anuluj</button>
        <button type="button" className="btn" onClick={() => void copy()} disabled={!text}>Kopiuj treść</button>
        <button type="button" className="btn btn-primary" onClick={open} disabled={!href || !text || landline}>
          {kind === 'sms' ? 'Otwórz w telefonie' : 'Otwórz w programie pocztowym'}
        </button>
      </>
    }>
      {card.row.dnc ? <div className="alert alert-warn">Lead oznaczony: nie kontaktować{card.lead?.dncReason ? ` (${card.lead.dncReason})` : ''}.</div> : null}
      {recipients.length === 0 ? <div className="alert alert-warn">{kind === 'sms' ? 'Brak numeru telefonu u tego leada.' : 'Brak adresu e-mail u tego leada.'} Dodaj kontakt na zakładce „Kontakt”.</div> : (
        <Field label={kind === 'sms' ? 'Numer' : 'Adres'}>
          <select value={to} onChange={(e) => setTo(e.target.value)}>{recipients.map((r) => <option key={r} value={r}>{r}</option>)}</select>
        </Field>
      )}
      {landline ? <div className="alert alert-warn">To numer stacjonarny — SMS nie dotrze.</div> : null}
      {sharedOwners >= MOBILE_SHARED_OWNERS ? <div className="alert alert-warn">Ten numer jest wspólny dla {sharedOwners} kont — to zapewne centrala lub rejestracja, nie telefon konkretnej osoby.</div> : null}
      <Field label="Szablon">
        <select value={templateId ?? ''} onChange={(e) => pick(e.target.value ? Number(e.target.value) : null)}>
          <option value="">(bez szablonu — pisz od zera)</option>
          {list.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Field>
      {list.length === 0 ? <p className="hint">Nie ma jeszcze szablonów tego rodzaju. Dodasz je w menu „Szablony”.</p> : null}
      {kind === 'email' ? <Field label="Temat"><input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field> : null}
      <Field label="Treść"><textarea rows={kind === 'sms' ? 5 : 9} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      {kind === 'sms' ? (
        <>
          <p className="counter" aria-live="polite">{smsCounterText(count)}</p>
          <label className="check"><input type="checkbox" checked={strip} onChange={(e) => setStrip(e.target.checked)} /> Usuń polskie znaki (więcej tekstu w jednym SMS)</label>
        </>
      ) : mail && !mail.bodyIncluded ? (
        <div className="alert alert-warn">Treść ma ponad {MAILTO_BODY_MAX} znaków — do programu pocztowego trafi tylko temat. Użyj „Kopiuj treść” i wklej ją do wiadomości.</div>
      ) : null}
      {warn.unknown.length ? <div className="alert alert-warn">Nieznane zmienne w szablonie: {warn.unknown.map((v) => `{{${v}}}`).join(', ')}.</div> : null}
      {warn.empty.length ? <div className="alert alert-warn">Puste pola: {warn.empty.join(', ')}. Uzupełnij je w treści przed wysłaniem.</div> : null}
      <p className="hint">Po otwarciu linku pojawi się formularz „Zapisz wynik kontaktu”.</p>
    </Modal>
  );
}
