// ==UserScript==
// @name         Form Faker
// @namespace    https://minoa.cat
// @version      1.4.0
// @description  Fill any form with realistic fake data pulled from US Census name lists. Smart field detection, framework compat, persistent cache with background refresh.
// @author       Minoa
// @homepage     https://minoa.cat
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      raw.githubusercontent.com
// @license      MIT
// @run-at       document-idle
// @downloadURL https://update.greasyfork.org/scripts/586783/Form%20Faker.user.js
// @updateURL https://update.greasyfork.org/scripts/586783/Form%20Faker.meta.js
// ==/UserScript==

(function () {
  'use strict';

  // ── config ───────────────────────────────────────────────────────────────────

  const NAME_URLS = {
    last:   'https://raw.githubusercontent.com/treyhunner/names/refs/heads/master/names/dist.all.last',
    male:   'https://raw.githubusercontent.com/treyhunner/names/refs/heads/master/names/dist.male.first',
    female: 'https://raw.githubusercontent.com/treyhunner/names/refs/heads/master/names/dist.female.first',
  };

  const STORAGE_KEY   = 'ff_name_cache_v1';
  const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days before silent background refresh

  // ── static data ──────────────────────────────────────────────────────────────

  const CITIES = [
    { city: 'Austin',           state: 'Texas',          zip: '78701' },
    { city: 'Denver',           state: 'Colorado',        zip: '80203' },
    { city: 'Atlanta',          state: 'Georgia',         zip: '30303' },
    { city: 'Phoenix',          state: 'Arizona',         zip: '85003' },
    { city: 'Portland',         state: 'Oregon',          zip: '97201' },
    { city: 'Nashville',        state: 'Tennessee',       zip: '37203' },
    { city: 'Charlotte',        state: 'North Carolina',  zip: '28202' },
    { city: 'Indianapolis',     state: 'Indiana',         zip: '46204' },
    { city: 'Columbus',         state: 'Ohio',            zip: '43215' },
    { city: 'Jacksonville',     state: 'Florida',         zip: '32202' },
    { city: 'Memphis',          state: 'Tennessee',       zip: '38103' },
    { city: 'Louisville',       state: 'Kentucky',        zip: '40202' },
    { city: 'Baltimore',        state: 'Maryland',        zip: '21201' },
    { city: 'Milwaukee',        state: 'Wisconsin',       zip: '53202' },
    { city: 'Albuquerque',      state: 'New Mexico',      zip: '87102' },
    { city: 'Tucson',           state: 'Arizona',         zip: '85701' },
    { city: 'Sacramento',       state: 'California',      zip: '95814' },
    { city: 'Kansas City',      state: 'Missouri',        zip: '64101' },
    { city: 'Omaha',            state: 'Nebraska',        zip: '68102' },
    { city: 'Raleigh',          state: 'North Carolina',  zip: '27601' },
    { city: 'Colorado Springs', state: 'Colorado',        zip: '80903' },
    { city: 'Virginia Beach',   state: 'Virginia',        zip: '23451' },
    { city: 'Boise',            state: 'Idaho',           zip: '83701' },
    { city: 'Richmond',         state: 'Virginia',        zip: '23219' },
    { city: 'Spokane',          state: 'Washington',      zip: '99201' },
    { city: 'Tulsa',            state: 'Oklahoma',        zip: '74103' },
    { city: 'Tampa',            state: 'Florida',         zip: '33601' },
    { city: 'St. Louis',        state: 'Missouri',        zip: '63101' },
    { city: 'Pittsburgh',       state: 'Pennsylvania',    zip: '15201' },
    { city: 'Salt Lake City',   state: 'Utah',            zip: '84101' },
  ];

  const STREETS    = ['Oak','Maple','Cedar','Pine','Elm','Washington','Park','Lake','Hillside',
                      'Riverside','Sunset','Valley','Forest','Meadow','Spring','Church','Main',
                      'Lincoln','Jefferson','Highland','Willow','Birch','Ash','Poplar','Walnut',
                      'Lakeview','Ridge','Orchard','Clearwater'];
  const STREET_SFX = ['St','Ave','Blvd','Dr','Ln','Ct','Pl','Way','Rd','Cir','Terrace','Trail','Loop','Pass'];
  const CO_ADJ     = ['Global','Advanced','Premier','Apex','Summit','Nexus','Dynamic','Precision',
                      'Unified','Streamline','Quantum','Vanguard','Core','Peak','Delta','Horizon',
                      'Catalyst','Integral','Meridian','Axiom'];
  const CO_NOUN    = ['Solutions','Systems','Technologies','Consulting','Services','Industries',
                      'Partners','Group','Ventures','Associates','Innovations','Networks',
                      'Dynamics','Analytics','Strategies'];
  const CO_SFX     = ['Inc.','LLC','Co.','Corp.','Ltd.','& Associates','International'];
  const EMAIL_DOM  = ['gmail.com','yahoo.com','outlook.com','hotmail.com','icloud.com',
                      'protonmail.com','mail.com','live.com','me.com','fastmail.com'];
  const MONTHS     = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];

  // ── session state ────────────────────────────────────────────────────────────

  let nameCache      = null;   // { last, male, female } in-memory for this page load
  let sessionProfile = null;   // reused within the same page load unless reset
  let fetchPromise   = null;   // in-flight fetch promise; shared by all concurrent callers

  // ── helpers ──────────────────────────────────────────────────────────────────

  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const pick = arr => arr[rand(0, arr.length - 1)];

  function parseNameFile(text) {
    const out = [];
    for (const line of text.trim().split('\n')) {
      const tok = line.trim().split(/\s+/)[0];
      if (tok && /^[A-Z']+$/.test(tok))
        out.push(tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase());
    }
    return out;
  }

  // GM_xmlhttpRequest runs at extension privilege level and is never subject to
  // same-origin / CORS restrictions — the browser does not apply those checks
  // to extension-level requests.
  function fetchText(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url,
        onload:    r => r.status === 200 ? resolve(r.responseText) : reject(new Error(`HTTP ${r.status}`)),
        onerror:   () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
        timeout: 20000,
      });
    });
  }

  // ── persistent storage ───────────────────────────────────────────────────────

  function loadStored() {
    try {
      const raw = GM_getValue(STORAGE_KEY, null);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (p && Array.isArray(p.last)   && p.last.length &&
               Array.isArray(p.male)   && p.male.length &&
               Array.isArray(p.female) && p.female.length) return p;
    } catch (_) {}
    return null;
  }

  function saveToStorage(data) {
    try { GM_setValue(STORAGE_KEY, JSON.stringify({ ...data, ts: Date.now() })); } catch (_) {}
  }

  function cacheAge() {
    try {
      const raw = GM_getValue(STORAGE_KEY, null);
      if (!raw) return Infinity;
      const p = JSON.parse(raw);
      return p && p.ts ? Date.now() - p.ts : Infinity;
    } catch (_) { return Infinity; }
  }

  // ── fetch pipeline ───────────────────────────────────────────────────────────

  /**
   * Fire the network fetch, or return the already-in-flight promise if one
   * exists. Using a shared promise (rather than a boolean flag) means a
   * second caller that arrives while the first fetch is still resolving
   * awaits the *same* result instead of getting an early no-op return — the
   * previous boolean-flag version silently did nothing for the second caller
   * even though nameCache was still empty.
   */
  function fetchAndStore(silent = false) {
    if (fetchPromise) return fetchPromise;

    fetchPromise = (async () => {
      if (!silent) toastLeft('fetching name lists...');
      try {
        const [lastTxt, maleTxt, femTxt] = await Promise.all([
          fetchText(NAME_URLS.last),
          fetchText(NAME_URLS.male),
          fetchText(NAME_URLS.female),
        ]);
        const fresh = {
          last:   parseNameFile(lastTxt),
          male:   parseNameFile(maleTxt),
          female: parseNameFile(femTxt),
        };
        nameCache = fresh;
        saveToStorage(fresh);
        if (!silent) toastLeft('name lists cached', 2500);
        else         toastLeft('name lists refreshed', 2500);
      } catch (err) {
        if (!silent) toastLeft(`fetch failed: ${err.message}`, 5000);
        else         console.warn('[FormFaker] background refresh failed:', err.message);
        throw err; // let awaiting callers see the failure
      } finally {
        fetchPromise = null;
      }
    })();

    return fetchPromise;
  }

  /**
   * Ensure nameCache is populated. Strategy (stale-while-revalidate):
   *
   *   1. already in memory             → return immediately (no I/O at all)
   *   2. stored cache present + fresh  → load instantly, skip network
   *   3. stored cache present + stale  → load instantly (fast fill), then
   *                                       silently refresh in background
   *   4. no stored cache               → block on fetch, show left toast
   *
   * fill() is called right after this resolves so cases 1-3 are always instant.
   * If two calls race in case 4, both now await the same fetchPromise instead
   * of the second one falling through with an empty nameCache.
   */
  async function ensureNames() {
    if (nameCache) return;

    const stored = loadStored();
    if (stored) {
      nameCache = stored;
      if (cacheAge() > CACHE_MAX_AGE) fetchAndStore(true); // not awaited — fire and forget
      return;
    }

    // first ever run — must block, and any concurrent caller awaits the same promise
    await fetchAndStore(false);
  }

  // ── profile generation ───────────────────────────────────────────────────────

  function makeProfile() {
    const gender    = Math.random() < 0.5 ? 'male' : 'female';
    const firstName = pick(nameCache[gender]);
    const lastName  = pick(nameCache.last);
    const loc       = pick(CITIES);
    const fn        = firstName.toLowerCase();
    const ln        = lastName.toLowerCase();

    const emailUser = pick([
      `${fn}.${ln}`,
      `${fn}${ln}`,
      `${fn[0]}${ln}`,
      `${fn}${rand(10, 99)}`,
      `${fn}.${ln.slice(0, rand(2, 4))}${rand(1, 9)}`,
    ]);
    const email = `${emailUser}@${pick(EMAIL_DOM)}`;

    const dobAge   = rand(18, 65);
    const dobYear  = new Date().getFullYear() - dobAge;
    const dobMonth = rand(1, 12);
    const dobDay   = rand(1, 28);
    const dobMM    = String(dobMonth).padStart(2, '0');
    const dobDD    = String(dobDay).padStart(2, '0');
    const dobYYYY  = String(dobYear);

    return {
      firstName, lastName,
      fullName:     `${firstName} ${lastName}`,
      email,
      emailConfirm: email,
      phone:        `(${rand(200, 999)}) ${rand(200, 999)}-${String(rand(1000, 9999))}`,
      company:      `${pick(CO_ADJ)} ${pick(CO_NOUN)} ${pick(CO_SFX)}`,
      username:     `${fn}${ln.slice(0, rand(2, 4))}${rand(10, 99)}`,
      street:       `${rand(100, 9999)} ${pick(STREETS)} ${pick(STREET_SFX)}`,
      address2:     Math.random() < 0.25 ? `Apt ${rand(1, 999)}` : '',
      city:         loc.city,
      state:        loc.state,
      zip:          loc.zip,
      country:      'United States',
      dob:          `${dobMM}/${dobDD}/${dobYear}`,
      dobIso:       `${dobYYYY}-${dobMM}-${dobDD}`,
      dobMonth:     dobMM,
      dobDay:       dobDD,
      dobYear:      dobYYYY,
      dobMonthName: MONTHS[dobMonth - 1],
      age:          String(dobAge),
      gender,
      url:          `https://${fn}${ln.slice(0, 4)}.example.com`,
    };
  }

  // ── field type detection ─────────────────────────────────────────────────────

  const SKIP_TYPES = new Set([
    'hidden','submit','button','reset','image','file',
    'checkbox','radio','range','color','password','search',
  ]);

  function getLabelText(el) {
    if (el.id) {
      try {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return lbl.innerText || lbl.textContent || '';
      } catch (_) {}
    }
    const wrap = el.closest('label');
    if (wrap) return wrap.innerText || wrap.textContent || '';
    const lid = el.getAttribute('aria-labelledby');
    if (lid) {
      const lbl = document.getElementById(lid);
      if (lbl) return lbl.innerText || lbl.textContent || '';
    }
    return '';
  }

  function detectFieldType(el) {
    const tag  = el.tagName.toLowerCase();
    const type = (el.type || 'text').toLowerCase();

    if (tag === 'input' && SKIP_TYPES.has(type)) return 'skip';

    const ac = (el.getAttribute('autocomplete') || '').toLowerCase().trim();

    const rawHints = [
      ac,
      el.name || '', el.id || '',
      el.placeholder || '',
      el.getAttribute('aria-label') || '',
      getLabelText(el),
      el.getAttribute('ng-model') || '',
      el.getAttribute('data-ng-model') || '',
      el.getAttribute('v-model') || '',
      el.getAttribute('wire:model') || '',
      el.getAttribute('formcontrolname') || '',
      el.className || '',
    ].join(' ');
    const hints = rawHints.toLowerCase().replace(/[-_]/g, ' ');

    // NOTE: street-address (single-field, spec-intended for a full address,
    // sometimes a <textarea>) and address-line1 (first of a split address)
    // are distinct per the WHATWG autofill spec but are coalesced here since
    // real-world forms essentially never use both patterns on the same page.
    const AC_MAP = {
      'given-name': 'firstName', 'additional-name': 'firstName',
      'family-name': 'lastName',
      'name': 'fullName',
      'email': 'email',
      'tel': 'phone', 'tel-national': 'phone', 'tel-local': 'phone', 'tel-area-code': 'phone',
      'organization': 'company',
      'street-address': 'street', 'address-line1': 'street',
      'address-line2': 'address2',
      'address-level2': 'city',
      'address-level1': 'state',
      'postal-code': 'zip',
      'country': 'country', 'country-name': 'country',
      'username': 'username', 'nickname': 'username',
      'bday': 'dob',
      'bday-day': 'dobDay', 'bday-month': 'dobMonth', 'bday-year': 'dobYear',
      'url': 'url',
      'sex': 'gender',
    };
    if (AC_MAP[ac]) return AC_MAP[ac];

    if (type === 'email') return /confirm|verify|re.?enter|repeat|again|second|retype/.test(hints) ? 'emailConfirm' : 'email';
    if (type === 'tel')   return 'phone';
    if (type === 'date')  return 'dob';
    if (type === 'url')   return 'url';
    if (type === 'number' && /\bage\b/.test(hints)) return 'age';

    const PATTERNS = [
      [/\bfirst.?name\b|\bfname\b|\bgiven.?name\b|\bforename\b/,                     'firstName'],
      [/\blast.?name\b|\blname\b|\bsurname\b|\bfamily.?name\b/,                      'lastName'],
      [/\bfull.?name\b|\byour.?name\b|\bdisplay.?name\b|\breal.?name\b/,             'fullName'],
      [/confirm.?email|email.?confirm|re.?enter.?email|verify.?email|retype.?email/, 'emailConfirm'],
      [/\bemail\b/,                                                                    'email'],
      [/\bphone\b|\btel\b|\bmobile\b|\bcell.?phone\b/,                                'phone'],
      [/\bcompany\b|\borganization\b|\borganisation\b|\bemployer\b/,                  'company'],
      [/address.?2|addr.?2|\bapt\b|\bsuite\b|\bunit\b|\bline.?2\b/,                  'address2'],
      [/\bstreet\b|address.?1|addr.?1|\baddress\b|\baddr\b/,                          'street'],
      [/\bcity\b|\btown\b|\blocality\b/,                                               'city'],
      [/\bstate\b|\bprovince\b|\bregion\b/,                                           'state'],
      [/\bzip\b|\bpostal\b|\bpostcode\b|\bzip.?code\b/,                               'zip'],
      [/\bcountry\b/,                                                                  'country'],
      [/\busername\b|\buser.?name\b|\bhandle\b|\bscreen.?name\b/,                     'username'],
      [/\bdob\b|\bbirth.?date\b|\bdate.?of.?birth\b|\bbirthday\b/,                    'dob'],
      [/\bbirth.?month\b|\bmonth.?of.?birth\b/,                                      'dobMonth'],
      [/\bbirth.?day\b|\bday.?of.?birth\b/,                                           'dobDay'],
      [/\bbirth.?year\b|\byear.?of.?birth\b/,                                         'dobYear'],
      [/\bage\b/,                                                                      'age'],
      [/\bgender\b|\bsex\b/,                                                          'gender'],
      [/\bwebsite\b|\burl\b|\bhomepage\b/,                                            'url'],
    ];

    for (const [pat, ft] of PATTERNS) if (pat.test(hints)) return ft;
    return 'unknown';
  }

  // ── framework compat ─────────────────────────────────────────────────────────

  function setInputValue(el, value) {
    if (el.disabled || el.readOnly) return false;
    const str = String(value);
    try {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      if (desc && desc.set) desc.set.call(el, str);
      else el.value = str;
    } catch (_) { el.value = str; }
    for (const evtName of ['input', 'change', 'blur'])
      el.dispatchEvent(new Event(evtName, { bubbles: true, cancelable: true }));
    // AngularJS's ngModel directive listens for the native 'input' event above
    // and normally calls $setViewValue itself in response — this manual call
    // is defense-in-depth for older/custom directive setups where that native
    // listener path isn't wired up, not strictly required in the common case.
    try {
      if (window.angular) {
        const $el   = window.angular.element(el);
        const mdl   = $el.controller('ngModel');
        const scope = $el.scope() || $el.isolateScope();
        if (mdl && scope) scope.$apply(() => mdl.$setViewValue(str));
      }
    } catch (_) {}
    return true;
  }

  function setSelectValue(sel, value, altValues = []) {
    if (sel.disabled) return false;
    const opts = Array.from(sel.options);
    const find = needle => {
      needle = String(needle).toLowerCase();
      return opts.find(o => o.text.toLowerCase() === needle) ||
             opts.find(o => o.text.toLowerCase().startsWith(needle)) ||
             opts.find(o => o.value.toLowerCase() === needle) ||
             opts.find(o => o.text.toLowerCase().includes(needle));
    };
    let opt = find(value);
    if (!opt) for (const alt of altValues) { opt = find(alt); if (opt) break; }
    if (!opt) return false;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    try {
      if (window.angular) {
        const scope = window.angular.element(sel).scope();
        if (scope) scope.$apply();
      }
    } catch (_) {}
    return true;
  }

  // ── visual feedback ───────────────────────────────────────────────────────────

  function flash(el) {
    const was = { outline: el.style.outline, transition: el.style.transition, outlineOffset: el.style.outlineOffset };
    el.style.transition    = 'outline 0.1s ease, outline-offset 0.1s ease';
    el.style.outline       = '2px solid #22c55e';
    el.style.outlineOffset = '1px';
    setTimeout(() => Object.assign(el.style, was), 900);
  }

  // ── toast system ──────────────────────────────────────────────────────────────
  //
  //   toastLeft  (bottom-left)  — fetch / cache status
  //   toastRight (top-right)    — fill results
  //
  // Each toast host is a Shadow DOM root, not a plain div. A plain div's
  // inline styles usually win the specificity fight against page CSS, but not
  // always: an ancestor with `transform`, `filter`, `perspective`, or
  // `contain: layout` on <body> creates a new containing block, which makes
  // `position: fixed` resolve relative to that ancestor instead of the
  // viewport — silently breaking placement on sites that use those properties
  // for unrelated reasons. A closed styling boundary via attachShadow (mode:
  // 'open' so we can still update it, but shadow *style* encapsulation is
  // unconditional regardless of open/closed) sidesteps this: page rules can't
  // reach in, and our styles can't leak out either.

  const _toasts = {};

  function showToast(side, msg, duration = 3500) {
    if (!document.body) return;

    if (!_toasts[side]) {
      const host = document.createElement('div');
      host.id = `__ff_toast_host_${side}`;
      Object.assign(host.style, {
        position: 'fixed',
        zIndex: '2147483647',
        pointerEvents: 'none',
        ...(side === 'left'
          ? { bottom: '16px', left: '16px' }
          : { top: '16px', right: '16px' }),
      });
      document.body.appendChild(host);

      const root = host.attachShadow({ mode: 'open' });
      const bubble = document.createElement('div');
      Object.assign(bubble.style, {
        padding: '7px 12px', borderRadius: '4px',
        background: '#18181b', color: '#d4d4d8', border: '1px solid #3f3f46',
        fontSize: '11.5px', fontFamily: '"SF Mono",Menlo,Consolas,monospace',
        lineHeight: '1.6', letterSpacing: '0.02em',
        boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
        transition: 'opacity 0.18s ease, transform 0.18s ease',
        opacity: '0', transform: 'translateY(4px)',
        maxWidth: '260px', userSelect: 'none', whiteSpace: 'normal',
      });
      root.appendChild(bubble);

      _toasts[side] = { host, bubble };
    }

    const { bubble } = _toasts[side];
    bubble.textContent = `ff  ${msg}`;
    bubble.style.opacity   = '1';
    bubble.style.transform = 'translateY(0)';
    clearTimeout(bubble.__tm);
    bubble.__tm = setTimeout(() => {
      bubble.style.opacity   = '0';
      bubble.style.transform = 'translateY(4px)';
    }, duration);
  }

  const toastLeft  = (msg, dur) => showToast('left',  msg, dur);
  const toastRight = (msg, dur) => showToast('right', msg, dur);

  // ── fill ──────────────────────────────────────────────────────────────────────

  function fill(emptyOnly = false) {
    const p = sessionProfile || (sessionProfile = makeProfile());

    const VALUES = {
      firstName: p.firstName, lastName: p.lastName, fullName: p.fullName,
      email: p.email, emailConfirm: p.emailConfirm,
      phone: p.phone, company: p.company, username: p.username,
      street: p.street, address2: p.address2,
      city: p.city, state: p.state, zip: p.zip, country: p.country,
      dob: p.dob, dobIso: p.dobIso,
      dobMonth: p.dobMonth, dobDay: p.dobDay, dobYear: p.dobYear,
      dobMonthName: p.dobMonthName,
      age: p.age, gender: p.gender, url: p.url,
    };

    let filled = 0, skipped = 0;

    document.querySelectorAll('input, select, textarea').forEach(el => {
      const tag = el.tagName.toLowerCase();

      if (tag === 'select') {
        if (emptyOnly && el.selectedIndex > 0) return void skipped++;
        const ft = detectFieldType(el);
        if (ft === 'skip' || ft === 'unknown') return;
        let ok = false;
        if      (ft === 'dobMonth') ok = setSelectValue(el, p.dobMonth, [p.dobMonthName, String(parseInt(p.dobMonth, 10))]);
        else if (ft === 'state')    ok = setSelectValue(el, p.state);
        else if (ft === 'country')  ok = setSelectValue(el, p.country, ['us', 'usa', 'united states of america']);
        else if (ft === 'gender')   ok = setSelectValue(el, p.gender, [p.gender === 'male' ? 'm' : 'f']);
        else if (VALUES[ft])        ok = setSelectValue(el, VALUES[ft]);
        if (ok) { flash(el); filled++; }
        return;
      }

      if (tag === 'textarea') {
        if (emptyOnly && el.value.trim()) return void skipped++;
        const ft = detectFieldType(el);
        if (ft === 'skip' || ft === 'unknown') return;
        if (VALUES[ft] && setInputValue(el, VALUES[ft])) { flash(el); filled++; }
        return;
      }

      // <input>
      if (emptyOnly && el.value.trim()) return void skipped++;
      const ft = detectFieldType(el);
      if (ft === 'skip' || ft === 'unknown') return;
      let val = VALUES[ft];
      if (val === undefined || val === null) return;
      if (val === '' && ft === 'address2') return;

      if (el.type === 'date')                        val = p.dobIso;
      if (el.type === 'number' && ft === 'age')      val = p.age;
      if (el.type === 'number' && ft === 'dobYear')  val = p.dobYear;
      if (el.type === 'number' && ft === 'dobMonth') val = String(parseInt(p.dobMonth, 10));
      if (el.type === 'number' && ft === 'dobDay')   val = String(parseInt(p.dobDay, 10));

      if (setInputValue(el, val)) { flash(el); filled++; }
    });

    const msg = filled > 0
      ? `filled ${filled} field${filled !== 1 ? 's' : ''}${skipped ? ` (${skipped} already set)` : ''}`
      : 'no fillable fields detected';
    toastRight(msg);
  }

  // ── run ───────────────────────────────────────────────────────────────────────

  async function run(emptyOnly = false, newProfile = false) {
    try {
      if (newProfile) sessionProfile = null;
      await ensureNames();
      if (!nameCache) return;
      fill(emptyOnly);
    } catch (err) {
      toastRight(`error: ${err.message}`, 6000);
      console.error('[FormFaker]', err);
    }
  }

  // ── commands + shortcuts ──────────────────────────────────────────────────────

  GM_registerMenuCommand('Fill Empty Fields',         () => run(true,  false), 'f');
  GM_registerMenuCommand('Fill Form (Overwrite All)', () => run(false, false), 'o');
  GM_registerMenuCommand('New Profile + Fill All',    () => run(false, true),  'n');

  document.addEventListener('keydown', e => {
    if (!e.altKey || !e.shiftKey) return;
    if (e.key === 'F') { e.preventDefault(); run(true,  false); } // Alt+Shift+F
    if (e.key === 'N') { e.preventDefault(); run(false, true);  } // Alt+Shift+N
  }, true);

})();