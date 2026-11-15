# RPWZL CRM — instrukcja dla właściciela

Ten dokument jest dla Ciebie, nie dla programisty. Każdy krok mówi, gdzie kliknąć i po co.
Szczegóły techniczne są w [SPEC.md](SPEC.md), [DATA_MODEL.md](DATA_MODEL.md) i [CONTRACT.md](CONTRACT.md).

Ważne zasady na start:

- Nigdy nie wklejaj nikomu (także Claude) hasła do bazy, „secret key” (`sb_secret_…`) ani haseł użytkowników.
  Aplikacja potrzebuje tylko adresu projektu i klucza publicznego („publishable key”, `sb_publishable_…`).
- Projekt Supabase jest na planie darmowym (Free): baza do 500 MB, **bez kopii zapasowych**, a projekt
  **usypia się po 7 dniach bez używania**. Dlatego raz w miesiącu pobieraj „Kopię danych CRM” (punkt 6).

## 1. Jednorazowe przygotowanie projektu Supabase

Projekt: `ivrtdxyymdrykphanotk` (region Frankfurt, eu-central-1).

1. **Wyłącz samodzielne zakładanie kont.** Panel Supabase → *Authentication* → *Sign In / Providers* →
   wyłącz „Allow new users to sign up”. Dzięki temu konta zakładasz tylko Ty.
2. **Zostaw logowanie e-mailem i hasłem** (Email provider włączony). Wyłącz „Confirm email”, jeśli zakładasz
   konta ręcznie z zaznaczonym „Auto Confirm User” (punkt 2).
3. **Udostępnij aplikacji tylko schemat `api`.** *Project Settings* → *Data API* → *Exposed schemas*: zostaw
   wyłącznie `api` (usuń `public` i `graphql_public`). Zapisz. Bez tego aplikacja zgłosi błąd połączenia.
4. **Adres strony.** *Authentication* → *URL Configuration* → *Site URL*: adres, pod którym będzie działać CRM
   (np. `https://crm.twojafirma.pl`). Dopóki nie ma hostingu, zostaw domyślny.
5. **Zastosowanie struktury bazy (migracje)** robi osoba techniczna komendą `supabase db push` z repozytorium,
   po Twojej zgodzie. Claude nie zmienia produkcyjnej bazy samodzielnie.
6. **Pierwszy właściciel na liście dostępu.** Po migracjach: *SQL Editor* → nowe zapytanie → wklej i uruchom
   (wstaw swój adres e-mail i imię):

   ```sql
   insert into crm.team_member (email, display_name, role) values ('twoj@adres.pl', 'Imię Nazwisko', 'owner');
   ```

## 2. Dodanie użytkownika (np. handlowca)

1. W CRM: *Użytkownicy* → „Dodaj użytkownika”: e-mail, imię i nazwisko, rola (*właściciel* lub *członek
   zespołu*), telefon (pojawi się w szablonach jako `{{opiekun_telefon}}`).
2. Od razu potem (nie zostawiaj samego wpisu z punktu 1 na później) w panelu Supabase: *Authentication* → *Users*
   → „Add user” → „Create new user”: ten sam e-mail, hasło (min. 12 znaków), zaznacz „Auto Confirm User”. CRM łączy
   konto z wpisem po adresie e-mail przy pierwszym logowaniu.
3. Przekaż hasło tej osobie osobnym kanałem (np. SMS-em, nie w tym samym e-mailu co adres CRM).

Odebranie dostępu: *Użytkownicy* → odznacz „aktywny” (działa od razu), a potem **zawsze** usuń konto tej osoby
w panelu Supabase (*Authentication* → *Users* → użytkownik → „Delete user”), żeby jej konto logowania nie mogło
później przejąć nowego adresu dodanego do CRM. Zmiana hasła: *Authentication* → *Users* → użytkownik → „Reset password” albo ustaw nowe hasło.
Ostatniego właściciela nie da się usunąć ani zdegradować.

## 3. Comiesięczne odświeżenie danych z rejestru

1. Pobierz aktualne pliki ZIP z rejestru RPWDL (te same co zwykle, 9 plików).
2. Otwórz narzędzie RPWDL (plik `leadfilter.html`), przeciągnij pliki ZIP, poczekaj na wczytanie.
3. Kliknij „Zapisz indeks do pliku” — powstanie `rpwdl-index-RRRR-MM-DD.json.gz` (ok. 60 MB).
4. W CRM: *Import* → wybierz ten plik. CRM porówna go z bazą i pokaże „Co się zmieni”: nowe wpisy, zmienione
   kontakty, wpisy, które zniknęły z rejestru. Plik nie jest nigdzie wysyłany w całości — tylko zmiany.
5. Przeczytaj podsumowanie. Jeśli pojawi się ostrzeżenie do zaznaczenia (np. „ponad 10% wpisów zniknęło”),
   upewnij się, że wczytałeś wszystkie 9 plików ZIP.
6. Kliknij „Zatwierdź import”. Nie zamykaj karty. Przy pierwszym imporcie przeglądarka wysyła do bazy ok. 600 MB
   danych, więc czas zależy głównie od szybkości wysyłania (upload) Twojego internetu: przy 20 Mbit/s samo wysyłanie
   trwa ok. 4 minut, przy 10 Mbit/s ok. 8 minut (razem z resztą pracy zwykle 5–10 minut). Kolejne importy wysyłają
   tylko zmiany i trwają krócej.
7. Jeśli import zatrzyma się z komunikatem, że baza odrzuciła dane z pliku albo że słownik wartości rejestru jest
   pełny, ponowienie z tym samym plikiem nie pomoże: dane sprzed importu są nienaruszone, przekaż komunikat osobie
   technicznej. Zajętość słownika (zwykle ok. 3,5 tys. z 32 767) widać w *Ustawieniach* → „Miejsce w bazie”.

Import **nigdy** nie zmienia statusów, notatek, zadań, opiekunów, tagów, oznaczeń „nie kontaktować” ani decyzji
walidacji. Wpisy, które zniknęły z rejestru, zostają w CRM z oznaczeniem „zniknął z rejestru”.

## 4. Eksport leadów (tylko właściciel)

*Leady* → ustaw filtry albo wybierz widok (np. „POZ”) → zaznacz wiersze lub „Zaznacz wszystkie” → „Eksport…”.

- **CSV (Excel)** — do arkusza. Separator `;` i polskie znaki działają w polskim Excelu.
- **Customer.io (People CSV)** — gotowy do importu w Customer.io (*People* → *Import* → *CSV*). Kolumna `id`
  jest stała dla każdego wpisu, więc ponowny import aktualizuje te same osoby zamiast tworzyć duplikaty.
  Leady bez e-maila i oznaczone „nie kontaktować” są domyślnie pomijane — okno pokazuje ile.

Każdy eksport jest zapisywany w dzienniku (kto, kiedy, ile wierszy), ale same dane nie są przechowywane. Eksport
całego rejestru (ok. 264 tys. wpisów) trwa 2–3 minuty.

Uwaga o zaufaniu: członek zespołu nie ma przycisku eksportu, ale widzi w CRM dane kontaktowe wszystkich wpisów
(tak działa praca z leadami) i technicznie mógłby je spisać strona po stronie. CRM tego nie rejestruje — dawaj
dostęp tylko zaufanym osobom i odbieraj go od razu po zakończeniu współpracy (punkt 2).

## 5. Miejsce w bazie (limit 500 MB)

*Ustawienia* → „Miejsce w bazie” pokazuje zajętość. Spodziewane (zmierzone na prawdziwym rejestrze): ok. 255–280 MB
po pierwszym imporcie, ok. 375–400 MB po dwóch latach pracy (górna granica jest tuż pod progiem ostrzeżenia 400 MB). Gdyby trzeba było zejść niżej, najprostsze jest
skrócenie historii zmian rejestru w *Ustawieniach* z 24 do 12 odświeżeń (ok. 7 MB mniej). Powyżej 400 MB CRM ostrzega, powyżej 450 MB blokuje import. Po przekroczeniu 500 MB
Supabase przełącza bazę w tryb „tylko do odczytu” — wtedy: przejście na plan Pro (ok. 25 USD/mies.) albo
zmniejszenie danych (krótsza historia zmian rejestru w *Ustawieniach*).

## 6. Kopia danych CRM (co miesiąc!)

Plan darmowy nie robi kopii zapasowych. *Ustawienia* → „Pobierz kopię danych CRM” zapisuje plik
`crm-kopia-RRRR-MM-DD.json.gz` ze wszystkim, co wpisał zespół (statusy, notatki, historia kontaktów, zadania,
szablony, listy, decyzje walidacji, użytkownicy). Danych z rejestru w nim nie ma — te odtwarzasz z pliku indeksu.
Plik zawiera dane osobowe: przechowuj go na firmowym dysku, nie wysyłaj e-mailem.

## 7. Projekt uśpiony („paused”) i odtwarzanie

- Po 7 dniach bez używania Supabase usypia darmowy projekt; CRM wtedy się nie łączy. Wejdź do panelu Supabase,
  otwórz projekt i kliknij „Restore project”. Po kilku minutach CRM działa jak wcześniej (dane zostają).
  Aby tego uniknąć, wystarczy, że ktoś z zespołu zaloguje się do CRM przynajmniej raz w tygodniu.
- Jeśli projekt zostałby utracony: osoba techniczna zakłada nowy projekt i stosuje migracje (punkt 1), Ty
  dodajesz siebie jako właściciela, importujesz plik indeksu rejestru (punkt 3), a potem *Ustawienia* →
  „Przywróć z kopii…” i wskazujesz ostatni plik `crm-kopia-…`. Stracisz tylko zmiany od daty tej kopii.
  Osoby z kopii wracają jako *członkowie zespołu* (kopia nigdy nie nadaje roli właściciela); innym właścicielom
  nadaj tę rolę ponownie w *Użytkownicy*.

## 8. Hosting aplikacji

Aplikacja to zestaw statycznych plików (folder `app/dist` po zbudowaniu). Można ją umieścić na dowolnym
hostingu statycznym; w repozytorium są gotowe ustawienia dla Vercel (`app/vercel.json`) oraz dla Netlify /
Cloudflare Pages (`app/public/_redirects`). Uwaga: darmowy plan Vercel „Hobby” zabrania użytku komercyjnego —
dla firmy potrzebny jest plan Pro albo inny hosting. W ustawieniach hostingu trzeba podać dwie wartości
publiczne: `VITE_SUPABASE_URL` i `VITE_SUPABASE_PUBLISHABLE_KEY` (panel Supabase → *Project Settings* → *API*).
Po ustaleniu adresu strony wpisz go w Supabase jako *Site URL* (punkt 1.4).

## 9. Opcja na przyszłość: sprawdzanie NIP w „Białej liście” MF

Nie jest wbudowane. Rządowe API pozwala sprawdzić, czy NIP jest czynnym podatnikiem VAT i jaka jest oficjalna
nazwa, ale ma dzienny limit (wg źródeł nieoficjalnych ok. 3 000 NIP-ów dziennie), więc nadaje się do sprawdzania
wybranych segmentów, nie całego rejestru. Opis w SPEC.md, punkt 6.9.
