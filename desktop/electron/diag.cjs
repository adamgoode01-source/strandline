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
    /* Parse it here first. Electron reports a syntax error in injected source
       as "Script failed to execute", with no line and nothing a try/catch in
       the page can reach - so the check happens where the message is useful. */
    try { new (require('node:vm').Script)(src, { filename: 'diag:' + name }); }
    catch (e) {
      try { fs.writeFileSync(out + ".badsrc", src); } catch (e2) {}
      say(name, { syntaxError: String((e && e.message) || e), sourceWrittenTo: out + ".badsrc" });
      return;
    }
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

    /* Start from no remembered alphabet. The shape names are saved on purpose
       so a second sheet needs no naming, which means a previous run's names
       are recalled and this run would test nothing. */
    await step('forget any remembered alphabet', `(async () => {
      if(!window.strandline.forgetAlphabet) return { skipped: true };
      return (await window.strandline.forgetAlphabet()) || {};
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

    /* The failure that was reported: the counts disagreed, and filling in
       printed order put every value on the wrong row. Reproduce the mismatch
       - mark a real data row as a heading, so there are 17 slots against 18
       printed lines - and assert the values still land where they are
       printed. Placement is by position now, so a miscounted row costs
       nothing and the mismatch is no longer dangerous. */
    await step('values land correctly despite a row-count mismatch', `(async () => {
      const want = ${BUNDLES};
      const firstData = AS.rows.findIndex(r => !r.skip);
      AS.rows[firstData].skip = true;          // 17 slots against 18 printed lines
      document.getElementById("rowPull").click();
      await new Promise(r => setTimeout(r, 4000));
      const data = AS.rows.filter(r => !r.skip);
      const msg = document.getElementById("rowPullMsg");
      const out = {
        slotsBeforePull: 17,
        rowsCarryingData: data.length,
        bundlesExact: data.filter((r, i) => r.bundle === want[i]).length,
        outOf: want.length,
        headingReclaimed: !AS.rows[firstData].skip,
        noBlindOverrideOffered: !document.getElementById("pullAnyway"),
        message: ((msg && msg.innerText) || "").slice(0, 200)
      };
      // reset for the clean pull that follows
      AS.rows.forEach((r, i) => { r.bundle = ''; r.qtyFt = ''; r.elong = '';
        r.pulled = false; r.seen = false; r.skip = !!AS.strips[i].likelyHeader; });
      AS.cursor = AS.rows.findIndex(r => !r.skip);
      stripShow();
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

    /* The line-work reader. The sheet draws QTY and elongation rather than
       typing them, so the text pull leaves both blank; this is the pass that
       recovers them with no key. Nothing may be named by the app itself
       beyond what the bundle counts prove. */
    await step('the line-work shapes come up for naming', `(async () => {
      const card = document.getElementById("shapeCard");
      const inputs = Array.prototype.slice.call(document.querySelectorAll("#shapeGrid input"));
      return {
        panelShown: !!card && card.style.display !== 'none',
        shapes: VT.clusters.length,
        characters: VT.rows.reduce((a,r)=>a+r.cells.reduce((b,c)=>b+c.seq.length,0),0),
        rows: VT.rows.length,
        learnedFree: Object.keys(VT.learned).length,
        conflicts: (VT.conflicts||[]).length,
        stillToName: VT.clusters.filter(c=>VT.names[c.id]==null).length,
        inputsRendered: inputs.length,
        // nothing may be filled in before the operator has named anything
        rowsStillEmpty: AS.rows.every(r => !(r.qtyFt||'').trim() && !(r.elong||'').trim())
      };
    })()`);

    /* Name the shapes the way a person would - by typing into the boxes -
       then assert the rows resolve to what the sheet says. The names below
       are read off the drawing; the app is not told any row's value. */
    await step('naming the shapes resolves the rows', `(async () => {
     try {
      const truth = ${JSON.stringify(PRADO_ROWS)};
      /* Work out each shape's character from the rows it appears in, using
         only the printed values a person would be reading off the sheet. */
      const want = {};   // cluster id -> character
      /* Line each read row up with the sheet by the bundle already sitting on
         it, not by counting. VT.rows covers every band including the two
         headings, so index alignment silently teaches the wrong characters -
         which is exactly what it did the first time this ran. */
      const truthFor = (row) => {
        const i = pullRowFor((row.y0 + row.y1) / 2);
        const r = i >= 0 ? AS.rows[i] : null;
        const b = r && (r.bundle || "").trim();
        return b ? truth.find(t => t[0] === b) : null;
      };
      /* The quantity cell is unambiguous - every character in it is printed on
         one line - so it is what the digits and letters are learned from. */
      VT.rows.forEach((row) => {
        const t = truthFor(row); if(!t) return;
        const q = row.cells.find(c=>c.col===1);
        if(q){
          const chars = t[1].replace(/\\s+/g,"").split("");   // "9X34A"
          const seq = q.seq.filter(x=>!x.solidus);
          if(seq.length === chars.length) seq.forEach((x,k)=>{ want[x.cluster] = chars[k]; });
        }
        /* The fraction halves are one digit each and the layout already says
           which is which, so they can be named directly. */
        const e = row.cells.find(c=>c.col===2);
        if(e){
          const m = /^(?:(\\d+)\\s+)?(\\d+)\\/(\\d+)$/.exec(t[2]);
          if(m){
            const num = e.seq.filter(x=>x.part==="num" && !x.solidus);
            const den = e.seq.filter(x=>x.part==="den" && !x.solidus);
            if(num.length === m[2].length) num.forEach((x,k)=>{ want[x.cluster] = m[2][k]; });
            if(den.length === m[3].length) den.forEach((x,k)=>{ want[x.cluster] = m[3][k]; });
          }
        }
      });
      /* Whatever is left in an elongation cell is the delta, the equals sign
         and the inch mark - printed, but carrying no value. A person naming
         shapes writes those down too; the reader strips anything that is not
         a digit out of each part. */
      VT.rows.forEach((row) => {
        const e = row.cells.find(c=>c.col===2); if(!e) return;
        e.seq.forEach(x => {
          if(x.solidus) return;
          if(want[x.cluster] == null && VT.names[x.cluster] == null) want[x.cluster] = "D";
        });
      });

      // type them into the real inputs
      let typed = 0;
      Array.prototype.slice.call(document.querySelectorAll("#shapeGrid input")).forEach(el=>{
        const id = el.dataset.shape;
        if(VT.names[id] != null || want[id] == null) return;
        el.value = want[id];
        el.dispatchEvent(new Event('input', { bubbles: true }));
        typed++;
      });
      await new Promise(r => setTimeout(r, 200));
      return {
        shapesTyped: typed,
        namedNow: Object.keys(VT.names).length,
        preview: (document.getElementById("shapePrev").textContent || '').split('\\n').slice(0,4)
      };
     } catch (err) {
      return { threw: String((err && err.message) || err),
               where: String((err && err.stack) || '').split('\\n').slice(0,3).join(' | ') };
     }
    })()`);

    await step('filling the rows from the line-work', `(async () => {
      const truth = ${JSON.stringify(PRADO_ROWS)};
      document.getElementById("shapeApply").click();
      await new Promise(r => setTimeout(r, 700));
      const data = AS.rows.filter(r => !r.skip);
      let qtyRight = 0, qtyWrong = [], elongRight = 0, elongWrong = [], blank = 0;
      data.forEach((r, i) => {
        /* Compare each row against the sheet row its own bundle names, so a
           heading that was reclaimed does not shift the whole comparison. */
        const t = truth.find(x => x[0] === (r.bundle || "").trim()); if(!t) return;
        if(!(r.qtyFt||'').trim() && !(r.elong||'').trim()){ blank++; return; }
        if((r.qtyFt||'').trim()){
          if(r.qtyFt === t[1]) qtyRight++; else qtyWrong.push((i+1)+': "'+r.qtyFt+'" vs "'+t[1]+'"');
        }
        if((r.elong||'').trim()){
          if(r.elong === t[2]) elongRight++; else elongWrong.push((i+1)+': "'+r.elong+'" vs "'+t[2]+'"');
        }
      });
      return {
        quantitiesCorrect: qtyRight, quantitiesWrong: qtyWrong,
        elongationsCorrect: elongRight, elongationsWrong: elongWrong,
        rowsLeftBlank: blank,
        bundlesStillIntact: data.filter(r => truth.some(t => t[0] === (r.bundle||"").trim())).length,
        markedUnverified: data.filter(r=>r.pulled && !r.seen).length,
        message: (document.getElementById("rowPullMsg").innerText || '').slice(0,200)
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
