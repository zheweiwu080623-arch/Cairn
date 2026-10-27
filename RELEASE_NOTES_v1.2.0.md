# Cairn v1.2.0 / Vol.2.6

Release date: 2026-10-27

Cairn is a dependency-free, local-first Node.js application platform for
collecting and presenting external information. It requires Node.js 22 or newer
and exposes HTTP server, desktop launcher, and CLI entry points.

## Highlights

- tablet network self-check and guided repair;
- local hotspot and same-listening IPv6 access;
- browser-based file transfer with bounded paths and size limits;
- PDF lab-deadline extraction with explicit failure reporting;
- wallpaper style classification and a learning-hub view;
- reduced notification load and record-only delivery from earlier releases.

## Public-release boundary

The public release contains source, tests, and neutral documentation. It does
not contain runtime data, credentials, browser profiles, mail, attachments,
databases, or personal learning plans. The learning-hub module ships as a
generic template; users should keep personal customisations outside the public
repository.

## Verification

- portable test suite: 126/126 passed;
- release archive: 423 files, no local user-home paths or private-key markers;
- supported runtime: Node.js 22 or newer.

## Upgrade

1. Back up the existing runtime data and configuration.
2. Extract the release beside the current installation.
3. Start with `node server.mjs`, `node launcher.mjs`, or `node bin/cairn.mjs`.
4. Verify `GET /api/health` before switching the launcher.

No personal data is included in the archive.
