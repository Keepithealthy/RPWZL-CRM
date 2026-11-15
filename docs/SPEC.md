# RPWZL CRM: product and functional specification

Version 1 (2026-11-15). Audience: the builders (DB, APP, IMPORT+VALIDATION) and reviewers. UI text is Polish
(quoted below exactly where it matters); code and comments are English. Data model: [DATA_MODEL.md](DATA_MODEL.md);
interface: [CONTRACT.md](CONTRACT.md) and `app/src/lib/contract.ts`; owner manual: [OPERATIONS.md](OPERATIONS.md).

## 0. Purpose, scope and owner decisions

A small CRM for Keep It Healthy's sales team (3 people) working leads from the public RPWDL register: all
**podmioty lecznicze** (29 843, e-mail on 98.6 %) and all **praktyki zawodowe** (234 207, phone, no e-mail).
The owner is not a programmer: every screen must explain itself in plain Polish.

Owner decisions that override the earlier design work in `/tmp/claude-work/crm-design/`:

1. Legal and consent topics are the owner's responsibility. **Not built:** consent ledgers, legal gates, policy
   switches, art. 14 trackers, QR/consent pages, contact blocking. **Built:** a normal "Nie kontaktować" flag
   (section 7.7).
2. Import everything (all podmioty and all praktyki).
3. Validation ("to dużo danych, ale nie wiadomo kto jest kim — trzeba to zwalidować") is a core module (section 6).
4. Roles: owner and member (section 1).
5. First segments: POZ and "Komercyjne centra wielospecjalistyczne", shipped as saved views (section 7.6).
6. E-mail marketing tool: probably Customer.io, no account yet: bulk export in Customer.io's People CSV format
   plus a generic CSV; no API integration (section 8).
7. No SMS provider: calls and SMS go through `tel:` / `sms:` links, then a quick "log outcome" form (section 4.4).
8. Supabase stays on the Free plan: 500 MB database, no backups, pauses after 7 days of inactivity. Hence the
   size budget (DATA_MODEL 9) and the owner-only "Pobierz kopię danych CRM" (section 8.3).

Infrastructure: Supabase project `ivrtdxyymdrykphanotk` (eu-central-1, Postgres 17); static SPA (Vite + React +
TypeScript) deployable to any static host (Vercel config and `_redirects` included). Hosting is not decided;
note that Vercel's Hobby plan forbids commercial use (OPERATIONS).

## 1. Users, roles, sign-in

- Supabase Auth, e-mail + password. Sign-ups are disabled; the owner creates the three accounts in the Supabase
  dashboard. Access is decided by the allowlist `team_member (email, role, active)`; everything else is denied.
- Screen "Logowanie": e-mail, hasło, button "Zaloguj". Errors: "Nieprawidłowy e-mail lub hasło."; on `CR402`:
  "To konto nie ma dostępu do CRM. Poproś właściciela o dodanie Twojego adresu e-mail." and sign-out. Link
  "Nie pamiętasz hasła?" shows: "Poproś właściciela o ustawienie nowego hasła w panelu Supabase." (no reset
  e-mails: the built-in mailer is limited to 2 e-mails per hour).
- Roles:

| capability | owner | member |
|---|---|---|
| browse, filter, open cards, saved views | yes | yes |
| change status, owner, tags, next step, validation, notes, activities, tasks | yes | yes |
| bulk actions: status, owner, tags, lists, validation, set "Nie kontaktować" | yes | yes |
| clear "Nie kontaktować" | yes | no |
| validation decisions (accept/reject proposals, detach/attach accounts) | yes | yes |
| templates, lists, private and shared views | yes | yes (own lists/views) |
| system views, statuses, tag deletion, settings, generic domains | yes | no |
| import / register refresh | yes | no |
| bulk export (CSV, Customer.io), "Pobierz kopię danych CRM", restore | yes | no |
| users screen | yes | no |

  A member can still copy a single phone or e-mail from a card (that is normal work, not an export). The UI hides
  owner-only entries; the database refuses them anyway (`CR403`).

## 2. Concepts

- **Wpis (entry)**: one register record (a podmiot or a praktyka), identified by its register key
  `src|organ rejestrowy|nr księgi|kseq` (section 5.2). The CRM never invents entries.
- **Lead**: an entry seen through CRM eyes: status, opiekun (owner), tags, validation, next step, history. Every
  entry is a lead with default values until someone changes it.
- **Konto (account)**: entries that are the same taxpayer: same valid NIP, plus manual corrections (section 6.2).
  A doctor running a podmiot (JDG) and two practices is one account with three entries.
- **Sieć (network)**: accounts the team confirmed as belonging together (chain, group, shared management),
  usually from a validation proposal (shared e-mail, domain, website, phone, partner).
- **Propozycja (proposal)**: a machine suggestion with a reason and a confidence 0–100, waiting for a human
  decision in the "Walidacja" screen.

## 3. Navigation

Left sidebar (collapses to a top bar below 900 px): "Dziś", "Leady", "Zadania", "Walidacja", "Listy",
"Szablony", and for the owner "Import", "Użytkownicy", "Ustawienia". Header: data-age line "Dane z rejestru: stan
na <report date>" (yellow banner "Dane z rejestru są starsze niż N dni — zaimportuj świeży indeks." when older
than `ui.staleDays`, default 35), the signed-in user's name and "Wyloguj". The record card opens as a route
`/lead/:id` (shareable within the team) over the list, and returns to the list keeping filters and scroll.

URLs: `/dzis`, `/leady?view=<id>&f=<compressed filter>`, `/lead/:id`, `/zadania`, `/walidacja`, `/listy`,
`/szablony`, `/import`, `/uzytkownicy`, `/ustawienia`. A filter in the URL is base64url of the JSON `LeadFilter`.

## 4. Screens

### 4.1 Common behaviour

- Every action gives feedback: a toast ("Zapisano", "Dodano do listy: 120 leadów"), or an inline Polish error from
  `ERROR_TEXT_PL`. Destructive actions ask first ("Usunąć zadanie? Tej operacji nie można cofnąć.").
- Register text is untrusted: rendered as text only (no HTML injection anywhere; lint rule enforces it).
- Empty states explain the next step (e.g. "Brak danych z rejestru. Właściciel musi najpierw zaimportować indeks
  (menu Import).").
- Numbers use Polish formatting (`27 167`), dates `dd.mm.rrrr`, Polish plurals (rekord / rekordy / rekordów).
- Keyboard: list rows focusable, Enter opens the card, Esc closes dialogs; visible focus; WCAG AA contrast.

### 4.2 "Leady" (list)

Layout: filter panel (left, collapsible), results (right). Top of results: view picker ("Widok: POZ — …"),
summary bar, bulk-action bar (when rows are selected), table, pager.

**Kind switch**: "Wszystkie / Podmioty lecznicze / Praktyki zawodowe" (`filter.kind`). Facet panels of the
other kind are hidden when one kind is chosen. With "Wszystkie", a facet selection of one kind restricts only rows
of that kind (rows of the other kind pass that facet); the panel says so: "Filtry podmiotów nie ukrywają praktyk."

**Register filters** (same facets and semantics as the offline tool: OR within a facet, AND across facets,
multi-valued fields match if any value is selected, faceted counts honour every other filter):

- Podmioty: "Status podmiotu" (`p.status`), "Rodzaj działalności leczniczej" (`p.rodzaje`), "Grupa specjalności
  komórek" (`p.grp`, labels from the 10 official groups + "?" = "Nieprzypisane / nieprawidłowy kod"),
  "Specjalności komórek" (`p.spec`, dependent on selected groups, label `kod — nazwa`), "Dziedzina" (`p.dz`),
  "Funkcja ochrony zdrowia" (`p.fn`, tree; a node selects its subtree), "Forma organizacyjno-prawna" (`p.forma`),
  "Typ formy" (`p.formType`: "Komercyjna (prywatna)", "Publiczna", "Inna"), "Liczba różnych poradni
  specjalistycznych (min.)" (`spec1Min`, chips 3 / 5 / 10), "Liczba komórek (min.)" (`nkMin`).
- Praktyki: "Źródło" (`r.src`), "Grupa praktyk" (`r.grupaPraktyk`), "Grupa zawodowa" (`r.gz`), "Typ praktyki"
  (`r.typ`), "Rodzaj praktyki" (`r.rodzaj`), "Rodzaj działalności" (`r.rd`), "Specjalizacja" (`r.spec`), "Zakres
  świadczeń" (`r.zakres`), "Forma" (`r.forma`), "Organ rejestrowy" (`r.organ`), "Status wpisu" (`r.status`:
  "Aktywny", "Zawieszony", "Nieaktywny").
- Both: "Województwo" (`p.woj`/`r.woj`), "Miejscowość" (contains), "Kontakt: ma e-mail / ma telefon / ma
  komórkę / ma stronę www / ma NIP", "Data wpisu do rejestru" (od / do, presets "ostatni miesiąc", "6 miesięcy",
  "12 miesięcy" = `wpisRel`), "Ostatnia zmiana wpisu od dnia" (`stanOd`), "Typ podmiotu" (entity type, 6.1),
  "Problem z NIP" (`nipStatus`), "Tylko główny wpis konta" (`accountPrimaryOnly`), "W rejestrze" (tak / zniknęły /
  wszystkie; default tak), "Nowe w ostatnim imporcie", "Zmienione w ostatnim imporcie".
- Search box above the table: "Szukaj: nazwa, NIP, e-mail, telefon".

**CRM filters**: "Status" (pipeline), "Opiekun" (incl. "bez opiekuna"), "Tagi" (dowolny / wszystkie), "Status
walidacji", "Następny krok" (zaległy / dziś / 7 dni / brak / ustawiony), "Nie kontaktować" (pokaż wszystkie /
ukryj / tylko oznaczone), "Ostatni kontakt" (nigdy / do 7 dni / do 30 dni / do 90 dni / ponad 90 dni), "Lista",
"Sieć" (w sieci / bez sieci / konkretna), "Ma otwartą propozycję walidacji".

Every multi-select: search box, "Zaznacz wszystko / Wyczyść / Odwróć", selected-count badge, per-option counts
(loaded when the panel is opened, `leads_facets`), "Wyczyść wszystkie filtry" at the top of the panel.

**Summary bar**: "Wyniki: N" and "z e-mailem: a · z telefonem: b · z komórką: c · z www: d · z NIP: e"
(`leads_count`), plus a text description of the active filters (like the offline tool's `describeState`).

**Table** (server-side paging 50 per page, max 200, `leads_search`): checkbox, "Nazwa" (2 lines max, full text in a
tooltip; badges: "zniknął z rejestru", "nie kontaktować", "nowy" when first imported in the last run), "Typ"
(entity-type icon + tooltip), "Miejscowość" (voivodeship in the tooltip; min. 220 px for "Nazwa", 3 lines below 1366 px), "E-mail", "Telefon" (komórka marked), "Status", "Opiekun",
"Następny krok" (date, red when overdue), "Walidacja" (badge; derived status in italics), optional columns via
"Kolumny": NIP, WWW, Data wpisu, Ostatnia zmiana wpisu, Poradnie spec., Zakłady, Komórki, Ostatni kontakt, Tagi,
Jakość e-maila, Jakość telefonu, Źródło. Sort by clicking headers (`SortKey`), default "Nazwa" ascending.
Column choice and page size are remembered per viewer in `localStorage` (try/catch).

**Saved views** ("Widoki"): system views (owner-managed), shared views (any member creates, everyone sees) and
private views. A view stores filter, sort and columns. Buttons: "Zapisz jako widok…", "Nadpisz widok", "Zmień
nazwę", "Usuń". Selecting a view replaces the current filters; changing filters after that shows "zmieniono"
next to the view name.

**Bulk actions** (select rows, or "Zaznacz wszystkie N wyników" which targets the filter, max 20 000):
"Zmień status", "Przypisz opiekuna", "Dodaj tag", "Usuń tag", "Dodaj do listy", "Usuń z listy", "Ustaw status
walidacji", "Oznacz: nie kontaktować" (owner also "Zdejmij oznaczenie"), and for the owner "Eksport…" (4.11).
Every bulk action shows a confirmation with the count ("Zmienić status 1 240 leadów na „Do kontaktu”?").

### 4.3 Karta leada (record card)

Header (always visible): name (+ "Nazwa krótka" editable pencil), entity-type label, source label, register
status, badges ("zniknął z rejestru dnia …", "nie kontaktować — powód", "nowy wpis"), CRM controls inline:
"Status" (select), "Opiekun" (select), "Tagi" (chips + add), "Następny krok" (date + short note), "Walidacja"
(select + "Lista kontrolna" button, 6.7). Quick actions: "Zadzwoń", "SMS", "E-mail", "Notatka", "Zadanie",
"Spotkanie".

Tabs (or stacked sections on narrow screens):

1. **"Historia"** (default): timeline newest first (`lead_timeline`), switch "Ten wpis / Całe konto". Items:
   calls/SMS/e-mails/meetings with outcome and body, notes, status/owner/validation/dnc changes ("Status: Nowy →
   Do kontaktu"), done tasks, register events ("Zmiana w rejestrze (import 2026-12-14): telefon 22… → 600…",
   "Pierwszy import", "Zniknął z rejestru"). Own entries editable for 24 h.
2. **"Kontakt"**: all e-mails and phones (register and CRM-added) with quality labels (6.4): e-mail "dobry /
   średni / słaby" + reasons ("darmowa skrzynka", "adres recepcji", "możliwa literówka: gmial.com → gmail.com?",
   "ten sam adres ma N innych kont"); phone "komórkowy / stacjonarny / inny / nie do wybrania", "wspólny z N
   kontami", "prawdopodobnie centrala"; WWW normalised and clickable (opens in a new tab with
   `rel="noopener noreferrer"`); data-age "Dane kontaktowe z rejestru, ostatnia zmiana wpisu: <stan>" ("brak zmian od
   migracji rejestru 10.11.2023" when stale). Per value: "Kopiuj", "Zadzwoń/SMS/E-mail", "Oznacz jako błędny",
   "Ustaw jako główny". "Dodaj kontakt" (e-mail, telefon, www, osoba: imię i nazwisko, stanowisko, telefon,
   e-mail, notatka).
3. **"Dane z rejestru"**: every register field from the entry and its detail `d`, following the offline tool's
   record card (its SPEC V2.5): addresses, register book, dates, podmiot tworzący, s.c. partners; for podmioty the
   active structure (zakłady → jednostki → komórki with specialty labels, dziedziny, funkcje, contacts, beds),
   rendered lazily per zakład; for practices the person, specializations, activities with places and phones,
   partners, suspensions. Footer: "Źródło: RPWDL, raport z dnia <date>. Wyszukaj w rejestrze po numerze księgi <ks>
   albo NIP <nip>."
4. **"Powiązane"**: same account (other entries with type and status; "Odłącz od konta" / "Dołącz do konta…"),
   network (name, members, "Usuń z sieci"), proposals involving this account (status, reason, "Otwórz w
   Walidacji"), lists containing the lead.
5. **"Zadania"**: open and done tasks of this lead; "Nowe zadanie".

### 4.4 Calling, SMS and e-mail (no provider)

- "Zadzwoń" on a number opens `tel:+48XXXXXXXXX` (9-digit national number from `parsePhone`; unparseable raw
  strings are offered as `tel:` of their digits with the warning "Numer może być niepełny"). On desktop the OS
  hands it to a softphone or a paired phone.
- "SMS" opens a composer: template picker (kind sms), body with variables filled, character counter ("52 znaki ·
  1 SMS"; GSM-7 160/153 per part, UCS-2 70/67 when the text has characters outside GSM-7 such as Polish
  diacritics), option "Usuń polskie znaki" (default from `sms.diacritics`), then "Otwórz w telefonie" =
  `sms:+48XXXXXXXXX?body=<encoded>` (only offered for mobile numbers; landlines show "To numer stacjonarny — SMS
  nie dotrze"). The link format must be checked on the team's phones (iOS and Android differ in body handling);
  fallback "Kopiuj treść".
- "E-mail" opens a composer with an e-mail template: subject and body filled, then "Otwórz w programie pocztowym"
  = `mailto:<addr>?subject=…&body=…` (body capped at 1 800 characters for link-length safety; longer → "Kopiuj
  treść" + mailto with subject only).
- After any of these the **"Zapisz wynik kontaktu"** form opens automatically (and can be dismissed): type (pre-set),
  number/address used (pre-set), outcome buttons (`OUTCOMES`, e.g. "Rozmowa", "Nie odbiera", "Poczta głosowa",
  "Zły numer", "Prosi o brak kontaktu"), note, and optional in the same save: new status, next step (date + note,
  quick picks "jutro", "za 3 dni", "za tydzień", "za miesiąc"), task, "Oznacz: nie kontaktować". Outcome "Zły
  numer" offers "Oznacz numer jako błędny"; "Prosi o brak kontaktu" pre-ticks "nie kontaktować" (the user can untick).
  One RPC (`activity_add`) saves everything.

### 4.5 "Dziś"

For the signed-in user: "Zaległe zadania", "Zadania na dziś", "Następne kroki na dziś" (my leads with
`nextStepAt ≤ today`), "Zmiany w rejestrze u moich leadów" (my leads with status other than the default that
changed/disappeared/returned in the latest import), "Propozycje walidacji do przejrzenia: N" (link). Each item
opens the card; tasks can be ticked done inline. Counters in the sidebar badge.

### 4.6 "Zadania"

List with tabs "Moje otwarte", "Wszystkie otwarte", "Zrobione"; filter by due date (zaległe / dziś / tydzień /
wszystkie) and assignee; columns: termin, tytuł, lead (link), przypisany, notatka. "Nowe zadanie" (lead optional).

### 4.7 "Walidacja"

Purpose line: "Tu potwierdzasz, kto jest kim: które wpisy to ten sam podmiot, które należą do jednej sieci i które
dane są błędne." Segment restriction at the top: "Pokaż tylko propozycje dla widoku: [Wszystkie / POZ / Centra /
…]" (`p_filter`).

Three queues (tabs with counters):

1. **"Konta"** — proposals `account_check` (same NIP but types that should not share it, e.g. a company and a
   practice), `person` (same professional licence number across different NIPs), `reg_duplicate` (two register
   rows with the same book number). Each card shows the reason, confidence, and the entries side by side (name,
   type, NIP, address, contacts, status). Buttons: "To ten sam podmiot" (accept: keep/merge into one account),
   "To różne podmioty" (reject; for `account_check` the minority entries are detached; the card lists them from the
   database's `detachIds`, and says so when nothing would be detached), "Później".
2. **"Sieci i duplikaty"** — proposals `email`, `domain`, `www`, `phone`, `partner`, grouped when their member sets
   are identical (one card listing all reasons, combined confidence 6.6). Buttons: "Potwierdź sieć" (choose an
   existing network or create one, default name = name of the largest member; the user can untick members), "To nie
   jest sieć", "Później". New members of an already decided proposal are highlighted ("Nowe od ostatniej decyzji: 2").
3. **"Rekordy do sprawdzenia"** — leads with effective validation "Do sprawdzenia" (`leads_search` with
   `validation: [1]`), sorted by the selected view; each row lists its problems (from `qflags`: "NIP z błędną sumą
   kontrolną", "brak działającego kontaktu", "możliwa literówka w e-mailu", …) and opens the card on the
   "Kontakt" tab with the checklist.

A decision is stored with who and when, written to the members' timelines, and respected by future imports
(section 6.8). Filters "Otwarte / Zdecydowane / Nieaktualne". Help text explains confidence in one sentence:
"Pewność to szacunek maszyny (0–100). Powyżej 80 zwykle wystarczy szybki rzut oka."

### 4.8 "Szablony"

Tabs "E-mail", "SMS", "Skrypt rozmowy". List + editor: name, subject (e-mail), body, active. Variable picker
inserts `{{nazwa}}` etc. (7.4); preview against a chosen lead; SMS counter as 4.4. Call scripts are shown in a
side panel when "Zadzwoń" is used.

### 4.9 "Listy"

Static lists of leads (e.g. "Kampania styczeń"): name, note, member count, created by. Open a list = leads list
filtered by `listId`. Members are added from the list screen bulk actions. Delete: creator or owner.

### 4.10 "Import" (owner)

Step 1 "Wybierz plik": explanation "Wybierz plik indeksu `rpwdl-index-….json.gz` zapisany w narzędziu RPWDL
(przycisk „Zapisz indeks do pliku”). Plik zostaje na Twoim komputerze — CRM odczytuje go w przeglądarce i wysyła
do bazy tylko zmiany." File input + drop zone. Validation: gzip/plain detection, header `format ===
'rpwdl-lead-index'`, `version === 2` (v1: refused with the message in CONTRACT 6.2; other: "Nieobsługiwana wersja
indeksu (N)."), format-change guard (more than 50 % of records without name or NIP in a source with ≥ 20 records,
or ≥ 50 records with no e-mail and no phone at all → refused "Format pliku wygląda na zmieniony — dane nie zostały
wczytane.").

Step 2 "Sprawdzanie zmian" (progress bar per phase: reading, comparing with the database, validation): then the
**preview** "Co się zmieni": per kind and in total — "Nowe wpisy", "Zmienione dane kontaktowe", "Inne zmiany w
rejestrze", "Wróciły do rejestru", "Zniknęły z rejestru", "Bez zmian", "Odrzucone rekordy (uszkodzone)"; for gone
and contact-changed entries that have CRM work (status ≠ default, owner, activities) a sample list "Te zmiany
dotyczą leadów, nad którymi pracujecie: …" (first 50). Warnings needing a tick: report date older than the latest
import; more than 10 % of a source gone; database space after import estimated above 450 MB. Text: "Import nigdy
nie zmienia statusów, notatek, zadań ani decyzji walidacji." The proposal line counts only proposals that will be open
after the import: those the database holds as decided and that gain no member are left out (`val_decisions().decidedProposals`; RD3-2).

Step 3 "Zatwierdź import" → progress (batches, time left) → result summary and link "Zobacz zmiany" (report of
`import_changes`: tabs nowe / zmienione / zniknęły / wróciły, filter "tylko leady z pracą w CRM"). Leaving the page
during step 3 asks for confirmation; an interrupted import is aborted and can be repeated (idempotent).

History table "Poprzednie importy": date, file, report date, counts, who.

### 4.11 Export dialog (owner)

Opened from the list ("Eksport…") for the selection or the whole filter. Choose format:

- "CSV (Excel)" — columns picker (8.1), options "Usuń duplikaty po NIP" (default on), "Usuń duplikaty po
  e-mailu", separator `;`/`,`, "UTF-8 z BOM" (on).
- "Customer.io (People CSV)" — fixed format (8.2), options "Identyfikator osoby: e-mail (domyślnie) / id",
  "Dodaj kolumnę phone (tylko jeśli w Customer.io telefon jest identyfikatorem)" (off).

Common: "Uwzględnij leady oznaczone „nie kontaktować”" (off; owner only), live count of rows and of skipped rows
by reason ("pominięto: nie kontaktować 12, brak e-maila 340, duplikaty 55"). File name
`rpwzl-<view-or-list-name>-<YYYY-MM-DD>.csv`. The export is built in the browser from `export_page` batches; a
progress bar shows; nothing is stored server-side except the `export_log` entry (who, when, filter, count).

### 4.12 "Ustawienia" (owner)

Sections: "Statusy lejka" (add, rename, colour, order, stage open/won/lost/paused, default; delete with
reassignment), "Tagi", "Walidacja" (minimum confidence shown, cluster limits `ValidationParams`, generic e-mail
domains table with kinds free / generic / typo / social and the auto-detected ones), "SMS" (diacritics default),
"Historia rejestru" (keep N imports, default 24), "Miejsce w bazie" (`db_usage`: bar "Zajęte 263 MB z 500 MB",
largest tables, explanation of what happens at 500 MB), "Kopia danych CRM" (8.3: "Pobierz kopię danych CRM",
"Przywróć z kopii…", last backup date remembered in `localStorage` with a reminder after 30 days).

### 4.13 "Użytkownicy" (owner)

Table: e-mail, imię i nazwisko (display name), rola, telefon (for templates), aktywny, ostatnio widziany.
"Dodaj użytkownika" adds the allowlist row and shows the two steps the owner must do in the Supabase dashboard
(OPERATIONS "Dodanie użytkownika"). Deactivate = immediate loss of access (next RPC). The last active owner cannot
be removed or demoted.

## 5. Import and monthly refresh rules

### 5.1 Source and flow

The source is the index file produced by the verified offline tool (format `rpwdl-lead-index`, version 2: v1
record + `wpis` + compact detail `d`; tool SPEC §6 and V2.6). The owner downloads the official RPWDL ZIPs monthly,
loads them into the offline tool, saves the index (`.json.gz`), and imports that file in the CRM. Parsing happens in
a Web Worker; the database receives JSON batches through RPCs (CONTRACT 6). No secret is involved: the owner is
signed in, the publishable key is public.

### 5.2 Identity

Register key = `src | organ rejestrowy | nr księgi | kseq` (podmioty: `d.org` and `d.ks`; practices: `organ` and
`d.ks`). Book numbers restart per registering body; measured on the real file: 3 residual collisions (Rpz, Rpzp,
Rpf, each a pair with the same NIP, 2 of 3 identical names) → `kseq` orders them by (wpis, name, NIP, file order)
and they get the `REG_DUPLICATE` flag plus a `reg_duplicate` proposal. NIP is a validation/linking attribute,
never the identity (17 podmioty and 220 practices have none). Group practices: the offline index fills a practice's NIP
with the first partner's NIP when the practice has none of its own (893 of 1 343 in the real file), so such a value
identifies a partner, not the practice (6.2).

### 5.3 What a refresh does

- Compares the file with the database by hashes (CONTRACT 6.3); sends only new, changed, returned and
  derived-only rows, and the keys of gone entries. Typical month: ~1 400 new, ~3 000–6 000 changed entries.
- **Never** writes CRM tables. Statuses, owners, tags, notes, activities, tasks, lists, contacts added by the
  team, "nie kontaktować" and validation decisions stay exactly as they were.
- Gone entries (`in_register = false`) keep all CRM data, show "zniknął z rejestru", and are hidden by the default
  "W rejestrze: tak" filter. If they reappear they are "returned".
- History: `reg_change` keeps, per changed entry and run, which field groups changed and the old values of
  contact, name, NIP, address and status fields (CONTRACT 6.5); the last 24 runs are kept.
- Validation is recomputed by the worker for the whole file (accounts, shared phones, quality, proposals) and
  respects stored decisions (6.8).
- If a lead marked "Zweryfikowany" has register contact changes after `validatedAt`, the card shows "Dane w rejestrze
  zmieniły się po weryfikacji" and the lead appears in "Dziś" for its owner; its validation status is not changed.

### 5.4 Guards

Refuse: wrong format/version, format-change guard (4.10), another import running (`CR423`), database above 450 MB.
Confirm (tick): report date older than the latest run, > 10 % of a source gone, estimated size above 450 MB after.

## 6. Validation rules ("kto jest kim")

All per-entry rules are pure functions in `app/src/features/validation/rules.ts`, unit-tested, run by the import
worker; their outputs are stored (`DerivedFields`). Reference numbers are from the real 2026-11-14 register
(computed by the architect from the raw data; IMPORT builder re-checks them in a local run, never in tests).

### 6.1 Entity type

| type | rule |
|---|---|
| 3 "Podmiot publiczny" | kind p and `formTypeOf(forma) = 'publiczna'` (offline tool V2.1.5) |
| 2 "Osoba fizyczna prowadząca podmiot (JDG)" | kind p and `forma` starts with `działalność gospodarcza prowadzona przez osobę fizyczną` (incl. the "bez celu osiągania zysku" variant) |
| 1 "Spółka / podmiot prawny" | other kind p (companies, cooperatives, foundations, associations, churches, `inna`, null forma) |
| 5 "Praktyka grupowa" | kind r and (`typ = 'grupowa'` or `src` ends with `g`) |
| 4 "Praktyka indywidualna" | other kind r |

Note for the UI: types 2, 4 and 5 and spółki cywilne describe natural persons (card label "Dane osoby fizycznej").

### 6.2 Accounts (same subject)

1. `nipStatus` (6.3). Only `OK` NIPs link entries automatically.
2. `accountKey = 'n:' + nip` for OK NIPs, else `'e:' + keyHash`.
3. Decisions override: a detached entry gets `'e:' + keyHash`; an attached entry gets the chosen account key.
4. `accountSize` = entries with the key; primary entry = podmiot before practice, then the most contact data
   (`4·tel + 2·email + 1·www`), then the lowest key hash.
5. Flags and proposals:
   - all entries of the account are of types {2, 4, 5} or all of one type → linked, confidence 95, no review;
   - the account mixes type 1 or 3 with a practice (type 4/5) → `ACCOUNT_CHECK` on all its entries and an
     `account_check` proposal (value = account key, confidence 60);
   - a group practice whose NIP equals one of its partners' NIPs (`d.w[].nip`) is treated as having no NIP of its own:
     `GROUP_NIP_IS_PARTNER` ("brak własnego NIP praktyki"), its account key is `'e:' + keyHash`, the NIP is not used for
     linking, `telShared` or the "duplicates by NIP" export (real data: 921 of 1 343 group practices, mostly the
     substituted partner NIP; the partner proposals of 6.6 are kept);
   - exceptions to `ACCOUNT_CHECK`: a podmiot of form spółka cywilna / jawna / partnerska with a group practice under the
     same NIP is one subject (not flagged); an account without a company (a JDG with practices, or practices only) is
     flagged (and proposed) exactly when "To różne podmioty" would detach an individual practice of another person: one
     that is not the same person as the JDG's name (else the primary's), where the same person means the names nest or
     the first name of one (not an initial) occurs in the other, and a practice carrying the reference licence number is
     always the same person; between two individual practices of one profession with different valid licence numbers only
     nesting counts, never the shared first name (`detachedPractices` = SQL `private.minority_entries`; VAL-R5-1, VAL-R5-2,
     VAL-R6-1);
   - a podmiot without a legal form is typed from its name (public institution → 3) and is a JDG when a practice with the
     same NIP has a name that nests with it (middle names and initials allowed, diacritics folded; VAL-R3-8) or when its
     name starts with "osoba fizyczna", otherwise type 1.
   Real data: 4 977 NIPs appear among both podmioty and practices; 17 748 NIPs repeat within practices (38 290
   entries).
6. `person` proposals: practices with the same OWN `npwz` (licence number, `d.npwz`) but different account keys → value
   `npwz:<profession>:<number>` (profession from the source: `lek`, `piel`, `fizjo`, `diag`; the four licence series
   overlap), confidence 90 when the holders' names nest and no member account is flagged `ACCOUNT_CHECK`, else 55
   (VAL-R3-2, VAL-R3-5; the card says why). Accepting moves only the person's own individual practices carrying that
   licence (`rec.d.npwz`) into one account — a valid-NIP (`n:`) account first, then the larger one — never whole
   accounts; it is refused (`CR422 account_check_first`) while a member account that holds a practice with this licence
   mixes a company / public body with practices, is flagged `ACCOUNT_CHECK`, or holds a practice of the same profession
   under another licence and another person's name (VAL-R3-3, RD2-1, RD2-2).
   A group practice's partner licences (`d.w[].npwz`) are kept apart (`Light.partnerNpwz`): they
   link the group practice to the partner's individual practice as a `partner` proposal (6.6), never as `person`
   (VAL-R2-1). The SQL accept of a `person` proposal refuses (CR422) when a member account holds a group practice.

### 6.3 NIP checks

`nipStatus`: no NIP → 0 (`NIP_MISSING`); not exactly 10 digits → 2 `BAD_FORMAT`; ten identical digits or a first digit
0 (zero-padded, VAL-R3-9) → 3 `PLACEHOLDER`; checksum (weights 6 5 7 2 3 4 5 6 7, sum mod 11 must equal the 10th digit; mod 11 = 10 is invalid) fails →
4 `CHECKSUM`; else 1 `OK`. Real data: podmioty OK 29 820, none 17, checksum 1, placeholder 5; practices OK 233 719,
none 220, checksum 197, bad format 61, placeholder 10. The offline tool's `nipKey` (no checksum) is still used for
`telShared` owners, to stay comparable with the tool.

### 6.4 Contact quality

**E-mail.** `normalizeEmail`: trim, strip `mailto:` and surrounding `<>`, lower-case. Valid syntax:
`^[a-z0-9!#$%&'*+/=?^_\`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_\`{|}~-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$`.
Domain classes (table `generic_domain`, seeded; owner-editable):

- free: `gmail.com, googlemail.com, wp.pl, o2.pl, onet.pl, onet.eu, op.pl, poczta.onet.pl, poczta.onet.eu, vp.pl,
  interia.pl, interia.eu, poczta.fm, tlen.pl, go2.pl, gazeta.pl, yahoo.com, yahoo.pl, hotmail.com, outlook.com,
  live.com, icloud.com, me.com, protonmail.com, proton.me, autograf.pl, buziaczek.pl, int.pl, neostrada.pl,
  post.pl, pro.onet.pl, vip.onet.pl, poczta.wp.pl, xl.wp.pl, wp.eu, onet.com.pl, spoko.pl, hot.pl, list.pl, adres.pl, data.pl,
  aol.com, yahoo.co.uk, yahoo.it, hoga.pl, opoczta.pl, epoczta.pl, e-poczta.pl, poczta.pl, pocztaplus.pl, upcpoczta.pl,
  pocztaemail.pl, europoczta.pl, vip.interia.pl, poczta.interia.pl, poczta.neostrada.pl, poczta.internetdsl.pl, esculap.pl,
  eskulap.pl, orange.pl, plusnet.pl, idsl.pl, ka.onet.pl, za.onet.pl, ns.onet.pl, le.onet.pl` and the ISP / portal
  mailboxes under shared suffixes `ape.net.pl, alias.net.pl, ak.net.pl, toya.net.pl, uznam.net.pl, krynica.net.pl,
  malbork.net.pl, konin.lm.pl, creator.wroc.pl, gryf.info.pl, amorki.pl, mierzeja.pl, 2com.pl, tpnet.pl, mail.pl,
  opoka.org.pl, kkw.com.pl` (VAL-R3-7; full list in the seed migration and `rules.ts`)
- typo (with suggestion): `gmial.com, gmai.com, gmail.pl, gmail.con, gmal.com, gamil.com → gmail.com; wp.p → wp.pl;
  0net.pl → onet.pl; intera.pl → interia.pl; o2.p → o2.pl; gmail.com.pl, gemail.com, gmali.com → gmail.com;
  interia.com → interia.pl; poczta.fm.pl, pocztafm.pl → poczta.fm; onet.poczta.pl → poczta.onet.pl; oent.pl, onte.pl,
  noet.pl, ont.pl, oet.pl → onet.pl; 02.pl → o2.pl`; a 1–2 character `.pl` name is a typo without a suggestion; a
  rule-derived typo (never a listed one) that is the domain of any WWW field in the file is a company domain (cos.pl,
  wpr.pl; VAL-R3-4); plus any domain at Damerau–Levenshtein distance 1 from `gmail.com` or `interia.pl`
  (long bases only: short ISP domains such as pnet.pl, net.pl, os.pl are real) that is not itself listed.
- generic (shared by unrelated institutions; not a network signal): `gov.pl` and every `*.gov.pl`, `*.mil.pl`,
  `mp.pl`, `zoz.org.pl`, `home.pl`, `webmedia.com.pl`, `bitserwis.pl`, `strazgraniczna.pl`, the regional NFZ domains
  `nfz-*.pl`, `teb-edukacja.pl`, sanepid hosts `psse-*` / `wsse-*` (worker only), and every company domain used by ≥ `genericDomainAccounts` (30) accounts in ≥ 3
  voivodeships (written as `auto`). Real data: `sanepid.gov.pl` 293 accounts, `sw.gov.pl` 130, `zoz.org.pl` 114,
  `mp.pl` 111. A row for a public second-level suffix (`com.pl`, `net.pl`, `org.pl`, `edu.pl`, `info.pl`, regional
  `wroc.pl` …; `PUBLIC_SUFFIXES` / `private.public_suffix`) matches only that exact domain, never the companies and
  universities registered under it (VAL-R3-1).
- Role mailbox: local part (before `+`) starting with `rejestracja, rejestr, recepcja, zapisy, przychodnia,
  poradnia, gabinet` (front desk) or `biuro, sekretariat, kontakt, info, office, poczta, administracja, kancelaria,
  centrala, mail, admin` (office). Real data: biuro 2 724, kontakt 1 687, sekretariat 1 322, info 907, rejestracja 823.

Score `emailQuality(e, sharedAccounts, stale)` (0–100): invalid syntax → 0; else 100, typo → set to 10; free −15;
front desk −15 or office −10; generic −5; shared by 2–5 accounts −10, ≥ 6 −20; stale −10; clamp 0..100. Labels:
≥ 75 "dobry", 45–74 "średni", < 45 "słaby". `qEmail` = best score among the entry's valid e-mails (podmioty);
practices null. Real data: 21 237 of 40 759 podmiot e-mails are on free domains.

**Phone.** `parsePhone` / classes exactly as the offline tool V2.1.2 (national numbering plan, Dz.U. 2024 poz. 1862):
`kom`, `stac`, `inny`, `zly`. Score `phoneQuality(n, owners, stale)`: kom 100, stac 85, inny 60; owners 2 → −10,
3–4 → −20, 5–9 → −35 ("prawdopodobnie centrala"), ≥ 10 → −50 ("centrala"); stale −10. A raw phone string that yields
no number scores 0 ("nie do wybrania"). `qPhone` = score of `telNorm` (null without number). `owners` = `telShared`
semantics of the tool V2.1.4 (distinct `nipKey` or entry, within the kind). `mobile` = the first mobile number of `nums`
used by fewer than 5 owners (distinct `nipKey` or account, all kinds); a mobile used by 5 or more owners (a network call
centre) stays in `nums` but sets `MOBILE_SHARED` and is never `mobile`, so "ma komórkę" and the Customer.io `sms_phone`
skip it (VAL-R3-6). Real file: 36 332 entries carry such a number.

**WWW.** `normalizeWww`: trim, lower-case, strip scheme, `www.`/`www2.`, port, path, query, fragment, trailing dot.
Invalid: empty, contains whitespace, contains `@` ("adres e-mail w polu WWW"), no dot, TLD not 2–24 letters, or in
the junk list `- , brak, brak wpisu, nie dotyczy, n/d, nd, ul., www, http, https`. Social/profile hosts (no network
signal): `facebook.com, fb.com, m.facebook.com, instagram.com, linkedin.com, twitter.com, x.com, youtube.com,
znanylekarz.pl, google.com, goo.gl, business.site`. Real data: 8 895 practices and ~14 000 podmioty have a WWW value;
junk values `-` 27, `brak` 16, `brak wpisu` 11, `ul.` 5.

**Staleness.** `stale` = `stan` is null or `stan ≤ staleBefore` (`2023-11-10`, the register migration date: the
record has not been touched since). Real data: 15 809 podmioty and 162 762 practices are stale.

### 6.5 `qflags`

Set by the worker per entry (bit names in `QFLAG`): NIP bits from 6.3; `NO_CONTACT` = no valid e-mail and no
parsed phone; `EMAIL_INVALID` / `EMAIL_TYPO` / `EMAIL_FREE` / `EMAIL_ROLE` / `EMAIL_SHARED` (≥ 2 accounts) from the
primary e-mail; `PHONE_UNPARSEABLE` (tel present, no number), `PHONE_SHARED` (2–9 owners), `PHONE_SWITCHBOARD`
(≥ 10); `WWW_INVALID` (also an e-mail or a street address typed into the field), `WWW_SOCIAL` (social profiles, portals and
hosts whose identity is in the path: sites.google.com, osoz.pl, linktr.ee …); `EMAIL_FROM_WWW` (a practice's e-mail taken
from the WWW field: it becomes the practice's e-mail for "ma e-mail" and the exports); `STALE`; `REG_DUPLICATE`; `GROUP_NIP_IS_PARTNER`; `INACTIVE` (status not
`aktywny` / `active`); `ACCOUNT_CHECK`; `MOBILE_SHARED` (6.4, not a problem bit). `QFLAG_PROBLEM_MASK` (contract.ts) decides the derived status.

### 6.6 Network and duplicate proposals

Built by the worker over the whole file, members are account keys (so an account with several entries counts
once), each proposal `(kind, matchValue)`:

| kind | value | members | confidence |
|---|---|---|---|
| `email` | normalised e-mail (any of `emails[]`) | 2 … `emailClusterMax` (30) accounts | 85 if ≤ 5 accounts, else 70 |
| `domain` | e-mail domain, not free/typo/generic | 2 … `domainClusterMax` (50) | 70 if ≤ 10, else 55 |
| `www` | normalised host, not social/generic/invalid | 2 … `wwwClusterMax` (50) | 80 if ≤ 10, else 65; only 45 (below the default minimum, so hidden) unless ≥ 2 members are podmiot accounts or share a name token (a practitioner listing the clinic's site, VAL-R2-5) |
| `phone` | 9-digit number (any of `nums`) | 2 … `phoneClusterMax` (3) accounts, at least two of them podmiot accounts (a practitioner listing the clinic's phone is not a network) | 60 |
| `partner` | `<accountA>><accountB>`; `npwz:<profession>:<number>` when the partner has no usable NIP | s.c. partner NIP (`d.sc[][1]`) or group-practice partner NIP (`d.w[].nip`) equal to another account's OK NIP; or a group practice's partner licence equal to an individual practice's own licence | 75 |
| `reg_duplicate` | register key without `kseq` | entries sharing `(src, org, ks)` | 90 |

A `domain` proposal whose member set equals an `email` proposal's set is not emitted (the e-mail is stronger).
Proposals with identical member sets share `groupKey` (SHA-256 of the sorted keys, 16 hex) and are shown as one card
with combined confidence `min(99, max + 5 × (count − 1))`. Hidden below `val.minConfidence` (50). Real-data scale:
1 127 e-mails shared by 2–24 accounts, 896 shared company domains before the generic rule, 431 shared WWW hosts,
1 593 s.c. partner NIPs matching another register NIP, 602 group practices with a partner who has an individual
practice. `partner` proposals are correct relations, not data problems: they stay reviewable in the network queue but are
not counted by `crm.v_open_member`, so they do not make an entry "Do sprawdzenia" (VAL-R2-2).

### 6.7 Validation status and checklist

Statuses: "Niezweryfikowany" (0), "Do sprawdzenia" (1), "Zweryfikowany" (2), "Odrzucony" (3).
- No human decision yet → **derived**: 1 if `qflags & QFLAG_PROBLEM_MASK` or the account is a member of an open
  proposal, else 0. Shown in italics with the reason list.
- Once a human sets a status it is stored on the lead and never changed by the system (set "Przywróć automatyczny"
  to go back to derived).
- "Lista kontrolna po rozmowie" (`ValidationChecklist`): "Podmiot istnieje i działa pod tym adresem", "Profil
  pasuje do naszej oferty", "Telefon działa i należy do tego podmiotu", "E-mail potwierdzony", "Strona WWW
  aktualna", "Osoba decyzyjna" (text), "Należy do sieci / grupy" (tak / nie / nie wiem), "Uwagi". Saving the
  checklist with all of the first three ticked suggests "Zweryfikowany"; "Podmiot nie istnieje" suggests "Odrzucony".
  Every change writes a `validation` activity.

### 6.8 Decisions respected by future imports

- Account links: `val_decision` (detach/attach by key hash) is read by the worker (`val_decisions`) and applied
  before accounts are computed.
- Proposals: identity `(kind, matchValue)`; decided proposals keep their status; only new members reopen them
  (CONTRACT 6.6); networks are CRM data and never changed by imports.
- Generic domains marked by the owner win over automatic detection.
- Lead validation statuses, checklists and notes are CRM data (never touched).

### 6.9 External enrichment (not built; option)

Ministry of Finance "Wykaz podatników VAT" (Biała lista) API `https://wl-api.mf.gov.pl`: lookup by NIP returns
name, VAT status (active / exempt / not registered), addresses, KRS, REGON, bank accounts. Limits reported by
secondary sources (not verified on a primary page in this session): method `search` 100 requests per day per IP,
up to 30 NIPs per request (≈ 3 000 NIPs a day, ≈ 90 days for every register NIP); method `check` 5 000 per day; a
daily flat file exists but only lets you verify NIP + bank account pairs, not names. A browser cannot call it
directly (cross-origin), so it would need a small server function (e.g. Supabase Edge Function) and a queue; useful
for spot checks of the POZ and centra segments ("czy NIP jest czynnym podatnikiem VAT"), not for the whole register.
Other options for later: KRS API (companies), GUS REGON BIR (needs a key).

## 7. CRM features

### 7.1 Leads and ownership

Opiekun = one team member or none. Assigning is a normal edit (any member). "Moje leady" = `owner: [me]`.

### 7.2 Pipeline statuses (configurable)

Default, seeded: 1 "Nowy" (open, default), 2 "Do kontaktu", 3 "Kontakt nawiązany", 4 "Zainteresowany",
5 "Spotkanie", 6 "Oferta" (open), 7 "Klient" (won), 8 "Nie teraz" (paused; suggests a next-step date), 9 "Odrzucony"
(lost). Every change writes a `status` activity with from/to.

### 7.3 Activities

User types: Telefon (`call`), SMS, E-mail, Spotkanie (`meeting`), Notatka (`note`) with outcomes in `OUTCOMES`;
system types: status, owner, validation, dnc, task done. `lastContactAt` = latest call/sms/email/meeting
`occurredAt`. Notes have a 5 000-character cap and the hint "Nie wpisuj danych o zdrowiu pacjentów."

### 7.4 Templates and variables

`{{nazwa}}` (cleanName of the register name), `{{nazwa_krotka}}` (short name, else nazwa), `{{miasto}}`,
`{{ulica}}`, `{{kod}}`, `{{woj}}`, `{{nip}}`, `{{osoba}}` (primary CRM person, else empty), `{{opiekun}}`,
`{{opiekun_telefon}}`, `{{opiekun_email}}` (lead owner, else the current user), `{{ja}}`, `{{ja_telefon}}`,
`{{ja_email}}` (current user), `{{data}}` (today `dd.mm.rrrr`). Rendering is client-side text substitution; unknown
variables stay visible and are listed as a warning; empty values are listed before opening the link ("Puste pola:
osoba"). Names are never inflected (Polish grammar), so templates should use "Dzień dobry," and the name in
nominative.

### 7.5 Tasks

Title, optional lead, due date (+ optional time), assignee (default me), note. Done/undone; done writes a `task`
activity on the lead. Overdue = due date < today and not done.

### 7.6 Saved views (system, seeded)

| name | filter | count on 2026-11-14 data |
|---|---|---|
| "POZ — podstawowa opieka zdrowotna" | kind p; `p.status` [aktywny]; `p.rodzaje` [Ambulatoryjne świadczenia zdrowotne]; `p.grp` [0] | 8 167 |
| "Komercyjne centra wielospecjalistyczne (5+ poradni)" | kind p; `p.status` [aktywny]; `p.formType` [komercyjna]; `spec1Min` 5 | 5 232 |
| "Nowe wpisy — 12 mies." | kind all; `p.status` [aktywny, nierozpoczety]; `r.status` [active]; `wpisRel` 12 | 1 942 podmioty + 14 461 praktyki |
| "Moje leady" | `owner` [me] (resolved at run time) | – |
| "Do kontaktu dziś" | `nextStep` today or overdue, `owner` [me], `dnc` exclude | – |

Notes (stored with the views, Polish) explain each definition as in the offline tool (POZ: active podmioty with
ambulatory activity and ≥ 1 active cell of group 0; centra: commercial legal form and ≥ 5 distinct specialist
clinics of group 1 excluding dental 18xx; threshold editable in the filter).

### 7.7 "Nie kontaktować"

A flag with optional reason on the lead (`dnc`). Effects: badge on the list and card; excluded from exports by
default (owner may include); quick actions still work but show a yellow warning "Lead oznaczony: nie
kontaktować (powód)". Anyone can set it; only the owner clears it. No other blocking.

## 8. Export formats

### 8.1 Generic CSV ("CSV (Excel)")

UTF-8 with BOM (option), separator `;` (option `,`), RFC 4180 quoting, every cell starting with `= + - @ TAB CR`
prefixed with `'` (spreadsheet formula guard; stated in the dialog). Polish headers in this order, user-selectable
(first five always): `Nazwa` (cleanName), `E-mail`, `Telefon`, `NIP`, `Miejscowość`, then optional `Telefon
komórkowy` (`48` + 9 digits), `WWW`, `Województwo`, `Ulica`, `Kod pocztowy`, `Źródło`, `Typ podmiotu`, `Forma
prawna`, `Status`, `Opiekun`, `Tagi` (`, `-joined), `Status walidacji`, `Następny krok`, `Ostatni kontakt`, `Data
wpisu`, `Ostatnia zmiana wpisu`, `Poradnie specjalistyczne`, `Zakłady`, `Komórki`, `Inne e-maile`, `Inne telefony`,
`Nie kontaktować`, `Klucz rejestru`, `ID CRM` (= key hash hex). Dedupe by NIP keeps the row with the highest
`4·tel + 2·email + 1·www` (ties: lowest id) and merges other members' contacts into `Inne …` (max 20); records
without an OK NIP are never merged. Dedupe by e-mail keeps one row per normalised e-mail with the same score rule.

### 8.2 Customer.io People CSV

Customer.io's documented requirements (docs.customer.io "Import people or events via CSV" and "Reserved attributes",
read 2026-11-15): CSV or Google Sheet, at most 100 columns and 100 MB, at least one identifier column (`id`,
`email` or `phone` depending on workspace settings); `id` is a string up to 150 characters; `email` must be a valid
RFC 5322 address; `phone` must be E.164 (e.g. `+48601234567`) to identify a person; `created_at` is a Unix
timestamp (integer); `unsubscribed` is boolean; the import UI maps headers to attributes and can add people to a
manual segment. In e-mail-identified workspaces two rows with the same e-mail conflict.

Our file: UTF-8 **without** BOM (a BOM would corrupt the first header), comma separator, RFC 4180 quoting, no
formula guard (it would alter values), lower-case snake_case headers, booleans `true`/`false`, dates as Unix
seconds:

| column | value |
|---|---|
| `id` | `rpwdl-` + key hash hex (16 hex), stable across refreshes and database rebuilds |
| `email` | best e-mail (CRM primary, else register primary unless marked invalid), lower-cased; when that cell is not one valid address (`a@x.pl, b@y.pl`), its first valid address or the first valid one of the entry's e-mails; rows without a valid e-mail are skipped when the identifier is e-mail (default) |
| `created_at` | Unix seconds of the import run that first brought the entry |
| `name` | cleanName |
| `short_name` | short name or name |
| `city`, `voivodeship`, `postal_code`, `street` | address |
| `nip` | digits |
| `sms_phone` | `+48` + mobile, or empty (custom attribute; column `phone` instead only if the owner ticks the option) |
| `phone_raw` | raw register phone |
| `website` | normalised host (no scheme, `www.`, path; lower case; the first valid one of a list) or empty when invalid or a social / portal host |
| `source` | source label (Polish) |
| `entity_type` | `podmiot_prawny`, `jdg`, `publiczny`, `praktyka_indywidualna`, `praktyka_grupowa` |
| `legal_form`, `form_type` | register form and `komercyjna`/`publiczna`/`inna` |
| `crm_status`, `crm_owner`, `crm_tags` | pipeline status name, owner display name, tags joined by `|` |
| `validation_status` | `niezweryfikowany`, `do_sprawdzenia`, `zweryfikowany`, `odrzucony` |
| `email_quality` | 0–100, of the exported address: the stored score capped by that address's own quality (RD3-1) |
| `register_entry_date`, `register_last_change` | Unix seconds (midnight UTC) or empty; empty also for dates before 1970 (Customer.io's handling of negative timestamps is not documented) |
| `specialist_clinics`, `units`, `cells` | `spec1`, `nz`, `nk` (podmioty) |
| `in_register` | `true`/`false` |
| `lead_ids` | when e-mail dedupe merged rows: the other rows' `id`s joined by `|` |

Dedupe by e-mail is always on for the e-mail identifier: winner = highest `email_quality`, then podmiot before
practice, then lowest id. The dialog shows how many rows were skipped (no e-mail, dnc, duplicates). The file never
contains `unsubscribed` (the CRM must not override Customer.io's subscription state).

### 8.3 "Pobierz kopię danych CRM" (owner backup)

Because the Free plan has no backups: one file `crm-kopia-<YYYY-MM-DD>.json.gz` (`BackupFile`), built in the
browser from `backup_export` pages, containing all CRM-entered data — team members and roles, statuses, tags,
settings, generic domains, templates, lists and members, saved views, leads (status, owner, tags, short name, dnc,
validation, checklist, next step), contacts, activities, tasks, networks, proposals with decisions, account
decisions — with entries referenced by register key (not internal ids). It does not contain register data (that is
re-importable from the index file). "Przywróć z kopii…" (owner): first import the register into an empty project,
then upload the backup; the app restores table by table (CONTRACT 7) and reports inserted / skipped / unresolved.
The settings screen reminds the owner monthly. The file contains personal data: the dialog says "Przechowuj plik
bezpiecznie (np. na firmowym dysku), nie wysyłaj go e-mailem."

## 9. Non-functional requirements

### 9.1 Performance (targets on the Free plan)

List page and count < 1.5 s; facet panel counts < 2 s; card open < 1 s (detail block read 0.8 ms locally); initial
import of 264 k entries < 15 min (measured 2 min 40 s against a local database; the screen says "kilka minut"), monthly refresh < 5 min; app bundle < 600 kB gzip on first load (lazy-load import,
validation and card detail renderer).

### 9.2 Browsers

Current Chrome, Edge, Firefox, Safari (desktop); phone layout usable for cards, calling, SMS and logging outcomes.
Import requires a desktop Chromium/Firefox/Safari with `DecompressionStream`.

### 9.3 Free-plan limits

Database size target ≤ 380 MB after two years (DATA_MODEL 9.3: projected 374–396 MB with the register size measured after the real first import (215–217 MB); the owner decides on the levers listed there). The app shows usage in
Settings, warns everyone above 400 MB ("Baza zbliża się do limitu 500 MB — powiadom właściciela") and refuses new
imports above 450 MB. Pause after 7 days of inactivity and no backups are handled in OPERATIONS (restore steps,
monthly backup file).

### 9.4 Security

Only the publishable key in the client; RPC-only access; RLS deny-all on tables; owner/member checks in every RPC;
CSP and frame denial headers (vercel.json); no third-party scripts, fonts or analytics; no data in URLs except
filter JSON and entry ids; `localStorage` only for UI preferences (no register data, no CRM data).

### 9.5 Testing

- Unit (vitest): `rules.ts` (phones incl. the offline tool's examples, e-mail/WWW normalisation and scores, NIP
  checksum, entity types), worker hashing and mapping, filter URL codec, template rendering, CSV builders
  (quoting, formula guard, Customer.io columns, dedupe).
- Database (pgTAP in `supabase/tests`): security matrix (anon / non-member / member / owner per RPC), filter
  semantics on synthetic rows (facet AND/OR, fn prefixes, wpisRel), import idempotency (same batch twice), refresh
  never touching CRM tables, proposal reopen rules, version conflicts.
- E2E (Playwright, local Supabase stack, synthetic index fixture): sign in, import fixture, apply a view, open a card,
  log a call with next step, run a refresh fixture and see the diff, export CSV and Customer.io (download content
  checked), validation accept/reject.
- Real data only in local containers under `/tmp/claude-work/crm-work/`, never in tests, fixtures, logs or
  screenshots in the repo.

## 10. Not in version 1

Sending e-mail or SMS from the CRM, any provider API (Customer.io, SMS gateways), consent/legal modules, deals and
values, reports and charts, calendar sync, mobile app, manual leads that are not register entries, Biała lista
enrichment, multi-language UI, audit beyond activities and the export log.
