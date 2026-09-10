/* Diagnostic run: drives the paths a person would use, without anyone
   clicking. Started with STRANDLINE_DIAG=<pdf path> and
   STRANDLINE_DIAG_OUT=<result file>.

   This exists because the desktop build failed in a way nothing else caught:
   Electron does not implement window.prompt, so "New project" threw and every
   upload control - all of which live on the project screen - was unreachable. */

const fs = require('node:fs');

async function runDiag(win, pdfPath, out) {
  const log = [];
  const say = (k, v) => log.push({ check: k, result: v });
  const run = (src, awaitPromise) => win.webContents.executeJavaScript(src, !!awaitPromise);

  try {
    say('layout', await run(`(() => {
      const home = document.getElementById('s-home');
      const projScreen = document.getElementById('s-project');
      const office = document.getElementById('officeCard');
      const drop = document.getElementById('pjDrop');
      return {
        onScreen: document.querySelector('.screen.on') && document.querySelector('.screen.on').id,
        officeCardInsideProjectScreen: !!(office && projScreen && projScreen.contains(office)),
        dropZoneInsideProjectScreen: !!(drop && projScreen && projScreen.contains(drop)),
        anyPdfUploadOnHome: !!(home && home.querySelector('input[type=file][accept*=pdf]')),
        projectCount: DB.projects.length
      };
    })()`));

    say('window.prompt', await run(`(() => {
      try { const r = window.prompt('t'); return { available: true, returned: String(r) }; }
      catch (e) { return { available: false, threw: String((e && e.message) || e) }; }
    })()`));

    // The whole flow, driven through the real controls.
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
      o.officeCardVisible = document.getElementById('officeCard').style.display !== 'none';
      o.dropZonePresent = !!document.getElementById('pjDrop');

      document.getElementById('pjAddForm').click();
      o.addBuildingFormAppeared = document.getElementById('addFormRow').style.display !== 'none';
      document.getElementById('addFormName').value = 'Building 3';
      document.getElementById('addFormCreate').click();
      await new Promise(r => setTimeout(r, 250));
      o.formsNow = proj().records.length;
      o.formName = proj().records[0].bldg;
      o.formInheritedTolerance = proj().records[0].tolInd;
      return o;
    })()`, true));

    // Upload a real PDF through the drop-zone input, exactly as a person would.
    if (pdfPath && fs.existsSync(pdfPath)) {
      const b64 = fs.readFileSync(pdfPath).toString('base64');
      say('upload a real plan set through the drop zone', await run(`(async () => {
        try {
          const raw = atob(${JSON.stringify(b64)});
          const u8 = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i) & 0xff;
          const file = new File([u8], 'PT shop drawings.pdf', { type: 'application/pdf' });
          const dt = new DataTransfer();
          dt.items.add(file);
          const input = document.getElementById('pjFile');
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          for (let i = 0; i < 60 && !(proj() && proj().plan); i++) await new Promise(r => setTimeout(r, 100));
          const p = proj();
          return {
            planStored: !!(p && p.plan),
            fileName: p && p.plan ? p.plan.name : null,
            pages: p && p.plan ? p.plan.pageCount : null,
            textStrings: p && p.plan && p.plan.tokens ? p.plan.tokens.length : 0,
            buildingsFound: p && p.plan ? (p.plan.buildings || []).map(b => b[0]) : [],
            scheduleTable: p && p.plan && p.plan.table ? p.plan.table.rows.length : 0,
            messageShown: (document.getElementById('pjPlanInfo').innerText || '').slice(0, 140)
          };
        } catch (e) { return { error: String((e && e.message) || e) }; }
      })()`, true));
    } else {
      say('upload a real plan set', { skipped: 'no pdf supplied' });
    }

    say('bridge surface', await run(`(() => ({
      pickPdf: typeof window.strandline.pickPdf,
      readPlans: typeof window.strandline.readPlans,
      settings: typeof window.strandline.settings.get,
      sync: typeof window.strandline.sync
    }))()`));

  } catch (e) {
    say('diagnostic threw', String((e && e.message) || e));
  }

  try { fs.writeFileSync(out, JSON.stringify(log, null, 2)); } catch (e) {}
  return log;
}

module.exports = { runDiag };
