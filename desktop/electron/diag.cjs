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
  const say = (k, v) => log.push({ check: k, result: v });
  const run = (src, awaitPromise) => win.webContents.executeJavaScript(src, !!awaitPromise);
  const flush = () => { try { fs.writeFileSync(out, JSON.stringify(log, null, 2)); } catch (e) {} };

  try {
    say('window.prompt', await run(`(() => {
      try { window.prompt('t'); return { available: true }; }
      catch (e) { return { available: false, threw: String((e && e.message) || e) }; }
    })()`));

    say('new project', await run(`(async () => {
      DB = { v:2, projects:[], activeProject:null, active:null, view:'home' };
      setView('home');
      document.getElementById('newProject').click();
      document.getElementById('newProjName').value = 'Prado Lofts at Meadowbrook';
      document.getElementById('newProjNo').value = '2622560140';
      document.getElementById('newProjCreate').click();
      await new Promise(r => setTimeout(r, 250));
      return { projects: DB.projects.length, onScreen: document.querySelector('.screen.on').id,
               assistCardVisible: document.getElementById('assistCard').style.display !== 'none' };
    })()`, true));
    flush();

    if (!(pdfPath && fs.existsSync(pdfPath))) { say('assisted entry', { skipped: 'no pdf' }); flush(); return log; }

    say('scan for ruled tables', await run(`(async () => {
      const t0 = Date.now();
      const res = await window.strandline.scanPlans({ pdfPath: ${JSON.stringify(pdfPath)} });
      if (res.error) return { error: res.error };
      AS.pdf = ${JSON.stringify(pdfPath)};
      AS.pages = res.pages;
      return { ms: Date.now() - t0, sheets: res.pages.length,
               candidates: res.pages.reduce((a, p) => a + p.candidates.length, 0) };
    })()`, true));
    flush();

    // Pick the schedule and let asChoose take us into row-by-row entry.
    say('pick the schedule, then cut it into rows', await run(`(async () => {
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
    })()`, true));
    flush();

    /* Type the schedule the way a person would: into the three fields, pressing
       Enter to advance. This is the interaction that has broken twice before,
       so it is driven through the real controls and the real key handler. */
    say('type all 18 rows, advancing with Enter', await run(`(async () => {
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
        type('rowBundle', rows[i][0]);
        type('rowQty', rows[i][1]);
        type('rowElong', rows[i][2]);
        enter('rowElong');
        await new Promise(r => setTimeout(r, 10));
      }
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
    })()`, true));
    flush();

    say('create the form', await run(`(async () => {
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
    })()`, true));
    flush();

    say('a wrong quantity is flagged on its own row', await run(`(() => {
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
    })()`));

  } catch (e) {
    say('diagnostic threw', String((e && e.message) || e));
  }

  flush();
  return log;
}

module.exports = { runDiag };
