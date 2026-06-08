# Packaging Local LLM Studio as a portable app

Goal: a download a non-technical person can run with **zero prerequisites** — no
Python, no separate Ollama install. The app bundles the Flask server + the Ollama
engine; models download on first use (Option A).

## What ships
```
Local LLM Studio.app  (macOS)  /  Local LLM Studio\  (Windows)
├── the frozen Python app (PyInstaller) — Flask + templates + static + vendor
└── the Ollama engine (vendor_bin/ollama[.exe], bundled next to the app)
```
On launch, `lls` (the entry point) starts the bundled Ollama if one isn't already
running, brings up the chat worker, and opens the browser. Models, chats, and config
live in a per-user data dir (NOT in the read-only app):
- macOS: `~/Library/Application Support/Local LLM Studio/`
- Windows: `%APPDATA%\Local LLM Studio\`

## Architecture (frozen-aware)
- `lls.py` — single entry. `lls` = supervisor; `lls --worker` = Flask worker.
- `ollama_runtime.py` — finds + starts the bundled engine, points `OLLAMA_MODELS`
  at the writable data dir.
- `app.py` / `supervisor.py` — expose `run_worker()` / `run()`; resolve templates
  & static from `sys._MEIPASS` when frozen; the supervisor re-invokes the single
  binary as the worker.
- `lls.spec` — the PyInstaller recipe (bundles assets + `vendor_bin/ollama`).

---

## A. Build on macOS (signed + notarized) — you run this
You need an Apple Developer ID (you have one). I can't enter credentials, so these
steps are yours.

1. **One-time: store notarization credentials** (an app-specific password from
   appleid.apple.com):
   ```bash
   xcrun notarytool store-credentials lls-notary \
     --apple-id "you@example.com" --team-id "YOURTEAMID" --password "xxxx-xxxx-xxxx-xxxx"
   ```
2. **Find your signing identity:**
   ```bash
   security find-identity -v -p codesigning   # copy the "Developer ID Application: …" line
   ```
3. **Build:**
   ```bash
   DEVELOPER_ID="Developer ID Application: Your Name (YOURTEAMID)" \
   NOTARY_PROFILE="lls-notary" \
   packaging/build-macos.sh
   ```
   → produces a signed, notarized `dist/Local-LLM-Studio.dmg`.

### Universal (Apple Silicon + Intel) in one DMG
`universal2` requires a **universal2 Python** (e.g. the python.org installer, not
Homebrew/conda) so the wheels are fat. With that Python:
```bash
LLS_TARGET_ARCH=universal2 DEVELOPER_ID="…" NOTARY_PROFILE="lls-notary" packaging/build-macos.sh
```
Otherwise, easiest path = let **CI build both arches** (below) and ship two DMGs, or
build each arch on its own Mac and `lipo` the binaries.

---

## B. Build everything via GitHub Actions — recommended
`.github/workflows/build.yml` builds **macOS arm64 + macOS x86_64 + Windows x64**
automatically, each with Ollama bundled.

1. Push the repo to GitHub (origin = your `GJBOW1/local-llm-studio`).
2. (Optional, for signed mac builds) add repo **Secrets**:
   - `MACOS_CERT_P12` — base64 of your exported Developer ID cert (`base64 -i cert.p12`)
   - `MACOS_CERT_PASSWORD`, `MACOS_DEVELOPER_ID`
   - `AC_APPLE_ID`, `AC_TEAM_ID`, `AC_PASSWORD` (app-specific password)
   Without these, CI still builds **unsigned** artifacts you can test locally.
3. Trigger: push a tag `git tag v1.0.0 && git push --tags`, or run the workflow
   manually from the Actions tab.
4. Download the artifacts (mac DMGs + Windows zip) from the run.

> Ollama release asset names occasionally change. If the fetch step 404s, check
> https://github.com/ollama/ollama/releases/latest and update the URL in
> `packaging/fetch-ollama.sh` / the Windows step of the workflow.

---

## C. Test the frozen build locally (no signing) — quick sanity check
```bash
pip install pyinstaller && pip install -r requirements.txt
packaging/fetch-ollama.sh                 # puts the engine in vendor_bin/
pyinstaller --noconfirm --clean lls.spec
open "dist/Local LLM Studio.app"          # macOS (first run: right-click → Open if unsigned)
# or:  "dist/Local LLM Studio/Local LLM Studio"   # the raw binary
```
Expect: Ollama starts, the browser opens to the glass UI, and picking a local model
downloads it on first use.

## Notes / decisions
- **Option A** (models download on first run) keeps the installer ~100–150 MB instead
  of multi-GB. The curated picker + progress modal already handle first-run pulls.
- **Cloud keys** stay in the per-user data dir, never bundled.
- **Icon:** drop `packaging/icon.icns` (mac) / `packaging/icon.ico` (win) to brand it;
  the spec picks them up automatically.
- The bundled Ollama is MIT-licensed and redistributable.
