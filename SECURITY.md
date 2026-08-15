# Security Policy

## What Nightlatch is — and is not

Nightlatch is a **curtain against casual snooping on a shared computer**, not a vault.

It stops the colleague who sits down at an unattended machine and starts clicking
through your Gmail, history and saved sessions. It does **not** stop a determined
attacker with access to the same OS account.

### Known and accepted limitations

| Limitation | Why it exists |
|---|---|
| Disabling the extension at `chrome://extensions` bypasses the lock | Every extension in this category shares this. We deliberately do **not** guard that page — it is the escape hatch when you forget your password, and blocking it would let users lock themselves out permanently. |
| Someone with the same OS account can read the Chrome profile directly from disk | A browser extension cannot defend the filesystem. Separate OS accounts (or full-disk encryption) are the correct control. |
| DevTools can remove the overlay | The overlay is rebuilt by a `MutationObserver`, but sustained manual tampering wins. That is "deliberate", not "casual" — outside the threat model. |
| Chrome's built-in PDF viewer and some internal pages cannot be covered | Content scripts cannot run there. Strict mode redirects the sensitive internal pages instead. |

**The real security baseline on a shared machine is `Win+L` (lock the OS) or a
separate OS account.** Nightlatch is a second curtain on top of that, for the
times you forget.

## Design choices that matter

- **Passwords are never stored.** Only a PBKDF2-SHA256 hash (600,000 iterations,
  16-byte random salt) is kept, in `chrome.storage.sync`. Verification is
  constant-time.
- **Lock state never syncs.** It lives in `chrome.storage.session` — per device,
  per browser run. Unlocking on one computer cannot unlock another. Several
  similar extensions get this wrong by putting lock state in `storage.sync`.
- **No network access.** The extension makes zero network requests, has no
  backend, no account and no telemetry. You can verify this by searching the
  source for `fetch`, `XMLHttpRequest` and `WebSocket` — there are none.
- **Brute force is rate-limited.** Four free attempts, then a cooldown starting
  at 30 s and doubling to a 5-minute cap, shared across all unlock surfaces.

## Reporting a vulnerability

Please open a GitHub issue for anything that is already public knowledge
(including everything in the table above).

For a bypass that is **not** in the table — something that defeats the lock
without disabling the extension or touching the filesystem — please report it
privately through GitHub's **Report a vulnerability** button (Security tab)
rather than a public issue.

Expect a slow but honest response: this is a personal side project maintained
in spare time, not a commercial product with an on-call team.
