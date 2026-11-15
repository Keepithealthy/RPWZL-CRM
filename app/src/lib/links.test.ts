import { describe, expect, it } from 'vitest';
import { MAILTO_BODY_MAX, isMobileNine, mailtoLink, nationalNumber, smsCount, smsCounterText, smsLink, stripPolish, telLink } from './links';

describe('phone links', () => {
  it('normalises national numbers', () => {
    expect(nationalNumber('600 000 001')).toBe('600000001');
    expect(nationalNumber('+48 22 000 00 01')).toBe('220000001');
    expect(nationalNumber('0048600000001')).toBe('600000001');
    expect(nationalNumber('12345')).toBeNull();
  });
  it('builds tel: and warns about incomplete numbers', () => {
    expect(telLink('600-000-001')).toEqual({ href: 'tel:+48600000001', incomplete: false });
    expect(telLink('22 123')).toEqual({ href: null, incomplete: true });
    expect(telLink('600 000 101, 600 000 102').href).toBeNull(); // two numbers glued together would be a wrong number
  });
  it('builds sms: only for 9-digit numbers and encodes the body', () => {
    expect(smsLink('600 000 001', 'Dzień dobry & miło')).toBe(`sms:+48600000001?body=${encodeURIComponent('Dzień dobry & miło')}`);
    expect(smsLink('123', 'x')).toBeNull();
  });
  it('knows mobile ranges', () => {
    expect(isMobileNine('600000001')).toBe(true);
    expect(isMobileNine('220000001')).toBe(false);
    expect(isMobileNine(null)).toBe(false);
  });
});

describe('mailto', () => {
  it('keeps the @ and encodes subject and body', () => {
    const r = mailtoLink('a@example.test', 'Oferta współpracy', 'Treść');
    expect(r.href).toBe(`mailto:a@example.test?subject=${encodeURIComponent('Oferta współpracy')}&body=${encodeURIComponent('Treść')}`);
    expect(r.bodyIncluded).toBe(true);
  });
  it('drops a body that is too long', () => {
    const r = mailtoLink('a@example.test', 'T', 'x'.repeat(MAILTO_BODY_MAX + 1));
    expect(r.bodyIncluded).toBe(false);
    expect(r.href).not.toContain('body=');
  });
});

describe('SMS counter', () => {
  it('counts GSM-7 text as 160 / 153', () => {
    expect(smsCount('a'.repeat(160))).toMatchObject({ parts: 1, unicode: false });
    expect(smsCount('a'.repeat(161))).toMatchObject({ parts: 2, perPart: 153 });
  });
  it('switches to UCS-2 for Polish diacritics (70 / 67)', () => {
    expect(smsCount('ą'.repeat(70))).toMatchObject({ parts: 1, unicode: true });
    expect(smsCount('ą'.repeat(71))).toMatchObject({ parts: 2, perPart: 67 });
  });
  it('counts extension characters twice', () => {
    expect(smsCount('{}').chars).toBe(4);
  });
  it('strips Polish letters and describes the counter', () => {
    expect(stripPolish('Zażółć gęślą jaźń ŁÓDŹ')).toBe('Zazolc gesla jazn LODZ');
    expect(smsCounterText(smsCount('Dzień dobry'))).toBe('11 znaków · 1 SMS (są polskie znaki)');
    expect(smsCounterText(smsCount('Hej'))).toBe('3 znaki · 1 SMS');
  });
});
