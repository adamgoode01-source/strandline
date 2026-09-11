/* Diagnostic run: drives the paths a person would use, without anyone
   clicking. Started with STRANDLINE_DIAG=<pdf path> and
   STRANDLINE_DIAG_OUT=<result file>.

   This exists because the desktop build has failed twice in ways nothing else
   caught - window.prompt not existing, and a selector collapsed from $$( to $(
   by String.replace - and both looked fine until a real interaction ran. */

const fs = require('node:fs');

/* The real POUR 1 schedule off sheet PT-02A. The answer is known: bundles 300
   through 420, which is 121 tendons. */
const PRADO_ROWS = [
  ['300 THRU 308', '9 X 34A', '2 1/2'],
  ['309 THRU 311', '3 X 51A', '3 7/8'],
  ['312', '1 X 54A', '4 1/4'],
  ['313 THRU 329', '17 X 57A', '4 1/2'],
  ['330', '1 X 60A', '4 3/4'],
  ['331 THRU 340', '10 X 80A', '6 3/8'],
  ['341 THRU 343', '3 X 125A', '10 1/8'],
  ['344 THRU 363', '20 X 135B', '10 7/8'],
  ['364 THRU 371', '8 X 34A', '2 1/2'],
  ['372 AND 373', '2 X 49A', '3 3/4'],
  ['374 THRU 379', '6 X 55A', '4 1/4'],
  ['380 AND 381', '2 X 56A', '4 3/8'],
  ['382 AND 383', '2 X 58A', '4 5/8'],
  ['384 AND 385', '2 X 59A', '4 5/8'],
  ['386', '1 X 59B', '4 5/8'],
  ['387 THRU 396', '10 X 80A', '6 3/8'],
  ['397 AND 398', '2 X 96A', '7 3/4'],
  ['399 THRU 420', '22 X 169B', '13 5/8']
];

async function runDiag(win, pdfPath, out) {
  const log = [];
  const flush = () => { try { fs.writeFileSync(out, JSON.stringify(log, null, 2)); } catch (e) {} };

  const say = (k, v) => {
    const at = log.findIndex(e => e.check === k);
    if (at >= 0) log[at].result = v; else log.push({ check: k, result: v });
    flush();
  };

  /* Each step is recorded as started before it runs, and given its own time
     limit. A renderer that hangs or dies takes the whole process down with it,
     and the first run of this file simply stopped writing after four checks -
     with no way to tell which step never came back. Now the file always names
     the step that was in flight, and one hung step does not cost the rest. */
  const LIMIT = 120000;
  const run = (src, userGesture) => {
    let timer;
    const capped = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('the page did not reply within ' + (LIMIT / 1000) + 's')), LIMIT);
    });
    return Promise.race([win.webContents.executeJavaScript(src, !!userGesture), capped])
      .finally(() => clearTimeout(timer));
  };
  /* When a step does not come back, the renderer is usually not dead but
     blocked, and nothing in the page can report that - every channel back
     runs on the thread that is stuck. The window title is the exception: the
     main process holds its own copy, so a step that sets it as it goes leaves
     a trail that survives the lock-up. */
  const step = async (name, src) => {
    say(name, { started: true, finished: false });
    try { say(name, await run(src, true)); }
    catch (e) {
      let lastMark = null;
      try { lastMark = win.getTitle(); } catch (e2) {}
      say(name, { failed: String((e && e.message) || e), lastMark });
    }
  };

  try {
    await step('window.prompt', `(() => {
      try { window.prompt('t'); return { available: true }; }
      catch (e) { return { available: false, threw: String((e && e.message) || e) }; }
    })()`);

    await step('new project', `(async () => {
      DB = { v:2, projects:[], activeProject:null, active:null, view:'home' };
      setView('home');
      document.getElementById('newProject').click();
      document.getElementById('newProjName').value = 'Prado Lofts at Meadowbrook';
      document.getElementById('newProjNo').value = '2622560140';
      document.getElementById('newProjCreate').click();
      await new Promise(r => setTimeout(r, 250));
      return { projects: DB.projects.length, onScreen: document.querySelector('.screen.on').id,
               assistCardVisible: document.getElementById('assistCard').style.display !== 'none' };
    })()`);

    if (!(pdfPath && fs.existsSync(pdfPath))) { say('assisted entry', { skipped: 'no pdf' }); return log; }

    await step('scan for ruled tables', `(async () => {
      const t0 = Date.now();
      const res = await window.strandline.scanPlans({ pdfPath: ${JSON.stringify(pdfPath)} });
      if (res.error) return { error: res.error };
      AS.pdf = ${JSON.stringify(pdfPath)};
      AS.pages = res.pages;
      return { ms: Date.now() - t0, sheets: res.pages.length,
               candidates: res.pages.reduce((a, p) => a + p.candidates.length, 0) };
    })()`);

    // Pick the schedule and let asChoose take us into row-by-row entry.
    await step('pick the schedule, then cut it into rows', `(async () => {
      AS.page = 5;
      const pg = AS.pages.find(p => p.page === 5);
      if (!pg || !pg.candidates.length) return { error: 'no candidates on sheet 5' };
      const target = { x:0.055, y:0.13, w:0.135, h:0.325 };
      let idx = pg.candidates.findIndex(c => {
        const ox = Math.min(c.box.x + c.box.w, target.x + target.w) - Math.max(c.box.x, target.x);
        const oy = Math.min(c.box.y + c.box.h, target.y + target.h) - Math.max(c.box.y, target.y);
        return ox > target.w * 0.6 && oy > target.h * 0.6;
      });
      const matched = idx >= 0;
      if (idx < 0) idx = 0;
      const t0 = Date.now();
      await asChoose(idx);
      const img = document.getElementById('stripImg');
      return {
        scheduleAmongCandidates: matched,
        ms: Date.now() - t0,
        rowByRowShown: document.getElementById('assistRowWork').style.display !== 'none',
        gridHiddenInstead: document.getElementById('assistWork').style.display === 'none',
        strips: AS.strips.length,
        firstStripShown: !!(img && img.src && img.src.indexOf('data:image') === 0),
        overviewShown: !!(document.getElementById('overviewImg').src || '').startsWith('data:image'),
        position: (document.getElementById('stripPos').textContent || ''),
        preSkipped: AS.rows.filter(r => r.skip).length,
        startsAtRow: AS.cursor + 1,
        dots: document.querySelectorAll('#stripDots button').length
      };
    })()`);

    /* The pull button with no API key saved. It must still do the free half -
       the sheet's own text layer - and on this set that is the whole bundle
       column, exactly. The message has to land where the button is: it used to
       be written to a card further down the screen, which is why the button
       looked dead. */
    const BUNDLES = JSON.stringify(PRADO_ROWS.map(r => r[0]));

    /* Rows are matched to strips in printed order, so a count mismatch would
       shift every value onto the wrong row - a bundle beside another row's
       elongation, with nothing about the result looking wrong. Force the
       mismatch and check the pull refuses rather than filling. */
    await step('a row-count mismatch fills nothing', `(async () => {
      const firstData = AS.rows.findIndex(r => !r.skip);
      AS.rows[firstData].skip = true;          // 17 slots against 18 text rows
      AS.pullForce = false;
      document.getElementById("rowPull").click();
      await new Promise(r => setTimeout(r, 4000));
      const msg = document.getElementById("rowPullMsg");
      const out = {
        nothingFilled: AS.rows.every(r => !(r.bundle || '').trim()),
        message: ((msg && msg.innerText) || "").slice(0, 170),
        offersToFillAnyway: !!document.getElementById("pullAnyway")
      };
      AS.rows[firstData].skip = false;         // put it back for the real pull
      return out;
    })()`);
    await step('pull button without a key reads the text layer', `(async () => {
      document.getElementById("rowPull").click();
      await new Promise(r => setTimeout(r, 4000));
      const msg = document.getElementById("rowPullMsg");
      const btn = document.getElementById("rowPull");
      const want = ${BUNDLES};
      const data = AS.rows.filter(r => !r.skip);
      return {
        buttonReEnabled: !btn.disabled,
        bundlesFilled: data.filter(r => (r.bundle || '').trim()).length,
        bundlesExact: data.filter((r, i) => r.bundle === want[i]).length,
        outOf: want.length,
        // the two columns this sheet drew as line art must stay empty
        qtyLeftEmpty: data.every(r => !(r.qtyFt || '').trim()),
        elongLeftEmpty: data.every(r => !(r.elong || '').trim()),
        markedUnverified: data.filter(r => r.pulled && !r.seen).length,
        messageNextToButton: ((msg && msg.innerText) || "").slice(0, 180),
        messageIsVisible: (() => {
          if (!msg || !msg.innerText.trim()) return false;
          const screen = document.querySelector(".screen.on");
          return msg.getBoundingClientRect().height > 0 && screen && screen.contains(msg);
        })(),
        pixelsFromButton: (!msg || !btn) ? null :
          Math.round(msg.getBoundingClientRect().top - btn.getBoundingClientRect().bottom),
        apiOfferedForTheRest: !!document.getElementById("pullWithApi"),
        stillOnProjectScreen: document.querySelector(".screen.on").id === "s-project"
      };
    })()`);

    /* Pressing the API offer with no key must explain, not fall back to local
       OCR - measured on this very table at 5 of 18 elongations exact and 8
       confidently wrong. It must also leave the free values alone. */
    await step('the API offer with no key explains itself', `(async () => {
      const api = document.getElementById("pullWithApi");
      if (!api) return { skipped: "no API offer button" };
      const before = AS.rows.map(r => r.bundle).join("|");
      api.click();
      await new Promise(r => setTimeout(r, 1200));
      const msg = document.getElementById("rowPullMsg");
      return {
        freeValuesKept: AS.rows.map(r => r.bundle).join("|") === before,
        message: ((msg && msg.innerText) || "").slice(0, 160),
        addKeyButtonOffered: !!document.getElementById("pullAddKey"),
        stillOnProjectScreen: document.querySelector(".screen.on").id === "s-project"
      };
    })()`);

    /* The key card the offer points at is on the home screen. Revealing it
       from here without navigating was the other half of the bug, so press the
       offer and check we actually arrive somewhere the operator can type. */
    await step('the offered key card is reachable', `(async () => {
      const add = document.getElementById("pullAddKey");
      if (!add) return { skipped: "no offer button" };
      add.click();
      await new Promise(r => setTimeout(r, 400));
      const card = document.getElementById("officeKeyCard");
      const input = document.getElementById("officeKeyInput");
      const screen = document.querySelector(".screen.on");
      return {
        onScreen: screen.id,
        cardOnThatScreen: !!(card && screen.contains(card)),
        cardShown: !!(card && card.style.display !== 'none' && card.getBoundingClientRect().height > 0),
        inputFocused: document.activeElement === input
      };
    })()`);

    /* Type the schedule the way a person would: into the three fields, pressing
       Enter to advance. This is the interaction that has broken twice before,
       so it is driven through the real controls and the real key handler. */
    await step('type all 18 rows, advancing with Enter', `(async () => {
      setView('project');
      const rows = ${JSON.stringify(PRADO_ROWS)};
      const type = (id, v) => {
        const el = document.getElementById(id);
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const enter = (id) => document.getElementById(id)
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const seen = [];
      for (let i = 0; i < rows.length && i < AS.strips.length; i++) {
        seen.push(document.getElementById('stripPos').textContent);
        document.title = 'diag row ' + i + ' bundle';
        type('rowBundle', rows[i][0]);
        document.title = 'diag row ' + i + ' qty';
        type('rowQty', rows[i][1]);
        document.title = 'diag row ' + i + ' elong';
        type('rowElong', rows[i][2]);
        document.title = 'diag row ' + i + ' enter';
        enter('rowElong');
        document.title = 'diag row ' + i + ' done';
        await new Promise(r => setTimeout(r, 10));
      }
      document.title = 'diag typing finished';
      const ex = asExpand();
      return {
        positionsVisited: seen.length,
        firstPosition: seen[0], lastPosition: seen[seen.length-1],
        cursorNow: AS.cursor,
        tendons: ex.tendons.length,
        statedTotal: ex.statedTotal,
        errors: ex.problems.filter(p => p.level === 'error').map(p => p.msg),
        contiguous: ex.tendons.every((t,i)=> i===0 || +t.mark === +ex.tendons[i-1].mark + 1),
        firstTendon: ex.tendons[0], lastTendon: ex.tendons[ex.tendons.length-1],
        anchorA: ex.tendons.filter(t=>t.anchor==='A').length,
        anchorB: ex.tendons.filter(t=>t.anchor==='B').length,
        dotsDone: document.querySelectorAll('#stripDots button.done').length,
        dotsBad: document.querySelectorAll('#stripDots button.bad').length,
        summary: (document.getElementById('rowSummary').innerText || '').slice(0, 150)
      };
    })()`);

    await step('create the form', `(async () => {
      document.getElementById('rowCreate').click();
      await new Promise(r => setTimeout(r, 350));
      const p = proj();
      const rec = p.records[p.records.length - 1];
      return {
        forms: p.records.length,
        tendons: rec.tendons.length,
        first: { mark: rec.tendons[0].mark, len: rec.tendons[0].len,
                 calc: rec.tendons[0].calc, anchor: rec.tendons[0].anchor },
        last: { mark: rec.tendons[rec.tendons.length-1].mark,
                calc: rec.tendons[rec.tendons.length-1].calc },
        tolerance: rec.tolInd,
        pdfBuilds: (() => { try { return buildPdf(rec, false).length > 0; } catch (e) { return String(e.message); } })()
      };
    })()`);

    await step('a wrong quantity is flagged on its own row', `(() => {
      const keep = JSON.parse(JSON.stringify(AS.rows));
      AS.rows = AS.rows.map(()=>({ bundle:'', qtyFt:'', elong:'' }));
      AS.rows[0] = { bundle:'300 THRU 308', qtyFt:'10 X 34A', elong:'2 1/2' };
      AS.cursor = 0;
      stripShow();
      const tally = document.getElementById('rowTally').textContent;
      const bad = document.querySelectorAll('#stripDots button.bad').length;
      const ex = asExpand();
      AS.rows = keep;
      return { tally, badDots: bad, errors: ex.problems.filter(p=>p.level==='error').map(p=>p.msg) };
    })()`);

  } catch (e) {
    say('diagnostic threw', String((e && e.message) || e));
  }

  flush();
  return log;
}

module.exports = { runDiag };
