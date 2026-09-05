# Strandline → TestFlight

Everything buildable is committed. What remains needs your Apple credentials, so it
has to be done by you — I can't create accounts or enter API keys.

Bundle ID in use: **`com.jcconcrete.strandline`**
Change it in `capacitor.config.json` **and** `codemagic.yaml` if you want a different one.

---

## 1 — Apple Developer portal

| # | Step | Where |
|---|------|-------|
| 1 | Register App ID `com.jcconcrete.strandline`, enable no special capabilities | Certificates, IDs & Profiles → Identifiers |
| 2 | Create an **App Store Connect API key**, role **App Manager** | Users and Access → Integrations → App Store Connect API |
| 3 | Download the `.p8` file. **It downloads once and cannot be re-downloaded.** Note the **Issuer ID** and **Key ID** | same page |

## 2 — App Store Connect

| # | Step |
|---|------|
| 1 | New App → iOS → name, primary language, bundle ID from above, SKU (any unique string, e.g. `STRANDLINE-001`) |
| 2 | TestFlight tab → Internal Testing → create a group named **JC Concrete Field** |
| 3 | Add testers by Apple ID email. Internal testers must be users on your App Store Connect team |

> The group name must match `beta_groups` in `codemagic.yaml`, or the upload
> succeeds but nobody is notified.

## 3 — Codemagic

| # | Step |
|---|------|
| 1 | Sign up at codemagic.io, connect the Git repo (see step 4) |
| 2 | Team settings → Integrations → **Apple Developer Portal** → add the Issuer ID, Key ID, and `.p8` |
| 3 | Name that integration exactly **`JC Concrete App Store Connect`** — it is referenced by name in `codemagic.yaml` |
| 4 | App settings → Environment variables → create a group named **`appstore`**, mark it **secure** (can be empty; the file expects the group to exist) |
| 5 | Start build → workflow **Strandline iOS - TestFlight** |

## 4 — Push the repo

Codemagic builds from GitHub, GitLab, or Bitbucket. There is a local commit but no remote:

```
git remote add origin <your-repo-url>
git push -u origin main
```

---

## What the build does

1. `npm ci` — installs Capacitor
2. `npx cap sync ios` — copies `www/index.html` into the Xcode project
3. `agvtool` — sets a fresh build number (App Store Connect rejects duplicates)
4. Fetches signing certs and provisioning profiles automatically
5. `xcode-project build-ipa` — archives and exports
6. Uploads to TestFlight and notifies the internal group

Expect **10–20 minutes** for the first run.

---

## Known gaps — read before you ship

**Fonts do not work offline.** The app still pulls Archivo, Public Sans, and IBM Plex
Mono from Google Fonts. In a native app on a job site with no signal, it falls back to
system fonts and looks wrong. Fix before field use: bundle the font files locally.

**Guideline 4.2 — minimum functionality.** Apple rejects apps that are only a website
in a webview. Internal TestFlight testing does *not* go through review, so this will not
block you now. It becomes a real risk if you ever move to external testing or the
App Store. Adding native share/file integration is the usual mitigation.

**Builds expire after 90 days.** A TestFlight build stops working at 90 days and must be
re-uploaded. For a tool crews depend on mid-pour, plan a recurring rebuild, or move to
Apple Business Manager custom app distribution, which does not expire.

**The Acrobat step is unchanged.** Crews still fill the PDF in Adobe Acrobat Reader —
that is where the form JavaScript runs. This wrapper does not change that workflow.
