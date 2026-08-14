# Installing Nightlatch

There are two ways to install. Pick **A** if you just want to use it; pick **B** if you want to run
the code you can see.

---

## A. From the Chrome Web Store (recommended)

1. Open the listing:
   **<https://chromewebstore.google.com/detail/nightlatch-%E2%80%94-profile-lock/mphdffkcmeklajdapjcgiojjhmikheif>**
2. Click **Add to Chrome** → **Add extension**.
3. The settings page opens on first run. Set a password (minimum 4 characters).
4. Click the puzzle-piece icon in the toolbar and **pin** Nightlatch so you can see the 🔒 badge.

Installing this way means Chrome keeps the extension updated automatically, and installs it on
your other signed-in computers for you.

---

## B. From source (developer mode)

Use this if you want to inspect and run the exact code yourself.

### 1. Get the files

**Option 1 — download a zip (no tools needed)**

1. Go to <https://github.com/yzoe236/nightlatch>.
2. Click the green **Code** button → **Download ZIP**.
3. Unzip it somewhere permanent, for example `D:\dev\nightlatch`.
   ⚠️ Chrome loads the extension *from that folder every time it starts* — if you delete or move
   the folder, the extension breaks.

**Option 2 — clone with git**

```bash
git clone https://github.com/yzoe236/nightlatch.git
```

### 2. Load it into Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the folder you just unzipped or cloned.
4. The settings page opens on first run — set your password.
5. Pin the extension from the puzzle-piece menu.

### 3. Repeat on every computer

Extensions loaded this way do **not** install themselves on your other machines, and they do not
auto-update. On each computer, repeat steps 1–4.

Your **password does sync** (only its hash is stored, in your Chrome account), so you set it once
and it works everywhere. The **lock state deliberately does not sync** — that is the whole point of
the extension.

### 4. Updating a source install

1. Replace the files with the new version (download the zip again, or `git pull`).
2. Open `chrome://extensions` and click **Reload (⟳)** on the Nightlatch card.

Keeping the same folder path on every computer makes this a two-step job forever.

---

## First run checklist

- [ ] Password set (Settings page)
- [ ] Extension pinned to the toolbar
- [ ] Press **Ctrl+Shift+L** — every tab should be covered by the lock screen
- [ ] Unlock with your password
- [ ] On a machine only you use, optionally switch off **Idle auto-lock on this computer**
      (Settings, or the checkbox in the popup)

## Verifying the per-device guarantee

This is worth doing once, because it is the reason the extension exists.

1. Install and set the same password on two computers.
2. Lock computer A (`Ctrl+Shift+L`), leave it.
3. Go to computer B and unlock it normally.
4. Return to computer A: **it must still be locked.**

## If you forget your password

Go to `chrome://extensions`, remove Nightlatch, and install it again. That page is deliberately
never blocked so you cannot permanently lock yourself out. Nothing readable is stored — only a
hash — so there is nothing to recover.

## Troubleshooting

| Symptom | Fix |
|---|---|
| A tab that was already open is not covered | Reload that tab. Tabs opened before install get the overlay injected, but a stubborn one may need a refresh. |
| Nothing happens on `chrome://extensions`, the Web Store, or a PDF | Extensions cannot draw on those pages. Strict mode redirects the sensitive ones to the lock screen instead; the extensions page is left reachable on purpose. |
| Auto-lock never fires | Check **Idle auto-lock on this computer** is on, and remember a tab playing audio counts as "in use". |
| The settings page reports an old version running | Click **Reload (⟳)** on the extension card, then reopen Settings. |
