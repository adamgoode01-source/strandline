# Strandline → TestFlight

Everything buildable is committed. What remains needs your Apple credentials, so it
has to be done by you — I can't create accounts or enter API keys.

Bundle ID in use: **`com.jcconcrete.strandline`**
Change it in `capacitor.config.json` **and** `codemagic.yaml` if you want a different one.

---

## 1 — Apple Developer portal — DONE

App ID registered, App Manager API key created, `.p8` downloaded.
Keep the **Issuer ID** and **Key ID** handy — Codemagic needs both.

## 2 — App Store Connect — app record DONE

Testers still to do. Not a blocker: the build will upload to TestFlight
regardless, and you assign it to testers afterward.

When you do create the group, name it **JC Concrete Field**, then uncomment
the `beta_groups` block at the bottom of `codemagic.yaml` so future builds
go out automatically.

## 3 — Codemagic

**There are no environment variables to create.** All three Apple values go into
one integration form.

Team settings → Integrations → **Apple Developer Portal** → Add key:

| Form field | What to paste | Where to find it |
|---|---|---|
| **Issuer ID** | UUID, e.g. `57246542-96fe-1a63-e053-0824d011072a` | App Store Connect → Users and Access → Integrations → App Store Connect API. Shown once at the top of the page, above the key list — it is per-account, not per-key |
| **Key ID** | 10 characters, e.g. `2X9R4HXF34` | Same page, the `KEY ID` column of your key row. Also embedded in the filename: `AuthKey_2X9R4HXF34.p8` |
| **API key** | Upload the `.p8` file itself | Your Downloads folder |
| **Name** | `JC Concrete App Store Connect` | Must match `codemagic.yaml` exactly |

Then: Start build → workflow **Strandline iOS - TestFlight**.

### If you would rather use environment variables

Only needed if you skip the integration. Group name `appstore`, marked secure,
and `groups: - appstore` must be added back under `environment:`:

| Variable | Value |
|---|---|
| `APP_STORE_CONNECT_ISSUER_ID` | the Issuer ID |
| `APP_STORE_CONNECT_KEY_IDENTIFIER` | the Key ID |
| `APP_STORE_CONNECT_PRIVATE_KEY` | full text of the `.p8`, including the BEGIN and END lines |
| `CERTIFICATE_PRIVATE_KEY` | an RSA private key for cert generation |

The integration route is fewer moving parts. Use it unless something forces otherwise.

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
