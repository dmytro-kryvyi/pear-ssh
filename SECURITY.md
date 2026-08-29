# Security Policy

Pear handles SSH credentials and opens shells on your servers, so security reports get
priority over everything else.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Instead use
[GitHub private vulnerability reporting](https://github.com/dmytro-kryvyi/pear-ssh/security/advisories/new)
— it opens a private thread with the maintainer.

You can expect an acknowledgement within a few days. Please include reproduction steps
and the affected platform (Linux/Windows desktop, Android).

## Design notes relevant to reports

- Secrets (passwords, passphrases, private keys) are encrypted at rest via Electron
  `safeStorage` (Keychain / DPAPI / libsecret) on desktop and Android Keystore on mobile.
- The renderer/UI process never receives secret material — only a "has a secret" flag.
  Any path that leaks material across that boundary is a vulnerability, report it.
- The Claude integration exposes hosts only through a loopback-bound MCP server with a
  fresh token per run. Anything reachable from off-loopback is a vulnerability.
- Pear has no backend: there is no server-side component to report against.
