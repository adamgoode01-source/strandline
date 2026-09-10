/* Diagnostic run: drives the paths a person would use, without anyone
   clicking. Started with STRANDLINE_DIAG=<pdf path> and
   STRANDLINE_DIAG_OUT=<result file>.

   This exists because the desktop build failed in a way nothing else caught:
   Electron does not implement window.prompt, so "New project" threw and every
   upload control - all of which live on the project screen - was unreachable.
   Checking that functions exist would not have found it. */

const fs = require('node:fs');

/* The real POUR 1 schedule off sheet PT-02A, typed as a person would type it.
   The answer is known: bundles 300 through 420, which is 121 tendons. */
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
      try { const r = window.prompt('t'); return { available: true, returned: String(r) }; }
      catch (e) { return { available: false, threw: String((e && e.message) || e) }; }
    })()`));

    say('flow: new project then add a building', await run(`(async () => {
      const o = {};
      DB = { v:2, projects:[], activeProject:null, active:null, view:'home' };
      setView('home');
      o.emptyStatePointsAtButton = /New project/.test(document.getElementById('projGrid').innerText);
      document.getElementById('newProject').click();
      o.newProjectFormAppeared = document.getElementById('newProjCard').style.display !== 'none';
      document.getElementById('newProjName').value = 'Prado Lofts at Meadowbrook';
      document.getElementById('newProjNo').value = '2622560140';
      document.getElementById('newProjCreate').click();
      await new Promise(r => setTimeout(r, 250));
      o.projectsNow = DB.projects.length;
      o.onScreen = document.querySelector('.screen.on').id;
      o.jobNoKept = (proj() || {}).jobNo;
      o.assistCardVisible = document.getElementById('assistCard').style.display !== 'none';
      return o;
    })()`, true));
    flush();

    // ---- assisted entry, end to end, entirely local ----
    if (pdfPath && fs.existsSync(pdfPath)) {
      const scan = await run(`(async () => {
        const t0 = Date.now();
        const res = await window.strandline.scanPlans({ pdfPath: ${JSON.stringify(pdfPath)} });
        if (res.error) return { error: res.error };
        AS.pdf = ${JSON.stringify(pdfPath)};
        AS.pages = res.pages;
        return {
          ms: Date.now() - t0,
          sheets: res.pages.length,
          sheetsWithTables: res.pages.filter(p => p.candidates.length).length,
          totalCandidates: res.pages.reduce((a, p) => a + p.candidates.length, 0),
          perSheet: res.pages.map(p => p.candidates.length)
        };
      })()`, true);
      say('scan the plan set for ruled tables (local, no API)', scan);
      flush();

      if (!scan.error) {
        // Sheet 5 is PT-02A. Pick the candidate that matches the known
        // schedule position so the rest of the flow can be driven.
        const choose = await run(`(async () => {
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
          await asChoose(idx);
          const img = document.getElementById('assistImg');
          return {
            scheduleWasAmongCandidates: matched,
            pickedIndex: idx,
            candidatesOnSheet: pg.candidates.length,
            cropShown: !!(img && img.src && img.src.indexOf('data:image') === 0),
            cropBytes: img && img.src ? img.src.length : 0,
            entryGridRows: document.querySelectorAll('#assistTable tbody tr').length
          };
        })()`, true);
        say('pick the schedule and enlarge it', choose);
        flush();

        const typed = await run(`(async () => {
          const rows = ${JSON.stringify(PRADO_ROWS)};
          AS.rows = rows.map(r => ({ bundle: r[0], qtyFt: r[1], elong: r[2] }));
          asRenderTable();
          asRenderSummary();
          const ex = asExpand();
          return {
            rowsTyped: rows.length,
            tendons: ex.tendons.length,
            statedTotal: ex.statedTotal,
            errors: ex.problems.filter(p => p.level === 'error').map(p => p.msg),
            warnings: ex.problems.filter(p => p.level !== 'error').length,
            firstTendon: ex.tendons[0],
            lastTendon: ex.tendons[ex.tendons.length - 1],
            anchorA: ex.tendons.filter(t => t.anchor === 'A').length,
            anchorB: ex.tendons.filter(t => t.anchor === 'B').length,
            contiguous: ex.tendons.every((t, i) => i === 0 || +t.mark === +ex.tendons[i-1].mark + 1),
            summaryText: (document.getElementById('assistSummary').innerText || '').slice(0, 130)
          };
        })()`, true);
        say('type the real schedule and expand it', typed);
        flush();

        const created = await run(`(async () => {
          document.getElementById('assistCreate').click();
          await new Promise(r => setTimeout(r, 300));
          const p = proj();
          const rec = p.records[p.records.length - 1];
          return {
            formsOnProject: p.records.length,
            tendonsOnForm: rec.tendons.length,
            firstMark: rec.tendons[0].mark,
            firstCalc: rec.tendons[0].calc,
            firstLen: rec.tendons[0].len,
            firstAnchor: rec.tendons[0].anchor,
            lastMark: rec.tendons[rec.tendons.length-1].mark,
            lastCalc: rec.tendons[rec.tendons.length-1].calc,
            inheritedTolerance: rec.tolInd,
            pdfBuilds: (() => { try { return buildPdf(rec, false).length > 0; } catch (e) { return String(e.message); } })()
          };
        })()`, true);
        say('create the form from the typed schedule', created);
        flush();

        // A wrong quantity must be caught, not absorbed.
        say('a quantity that disagrees with its range is flagged', await run(`(() => {
          const keep = AS.rows;
          AS.rows = [{ bundle:'300 THRU 308', qtyFt:'10 X 34A', elong:'2 1/2' }];
          const ex = asExpand();
          AS.rows = keep;
          return { tendons: ex.tendons.length, errors: ex.problems.filter(p=>p.level==='error').map(p=>p.msg) };
        })()`));
      }
    } else {
      say('assisted entry', { skipped: 'no pdf supplied' });
    }

  } catch (e) {
    say('diagnostic threw', String((e && e.message) || e));
  }

  flush();
  return log;
}

module.exports = { runDiag };
