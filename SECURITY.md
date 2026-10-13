# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**Do not report security vulnerabilities through public GitHub issues.**

Use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability). If that channel is not enabled,
open an issue asking for a private contact and leave out exploit details.

ACE runs agent tooling under `network: restricted` and
`filesystem: workspace` policies described in the ace/v1 spec. Reports
that show a way around those boundaries are especially welcome.

## What the installer touches

The security-relevant surface of this package is now `ace setup`, so its side
effects are stated exactly:

- **It writes only inside the target repository.** Nothing is written outside the
tree it was run in, and nothing is pushed, published or deployed.
- **It merges, and it never replaces.** The `ace` key is added to
`package.json`; every other key and value in that file is left byte-identical.
- **Generated files are not clobbered.** A generated file that already exists and
differs is left alone unless `--force` is explicit. Memory files are *seeded
once* and are never overwritten, not even with `--force`.
- **It starts nothing.** No agent is started, no terminal tab is created, no pane
is split, no browser is opened. `node orchestration/tabs.mjs up` does that later,
inside a running multiplexer, under the operator's own session.
- **`--dry-run` writes nothing at all**, so the plan can be reviewed before
anything exists on disk.
- **Credentials.** The installer never reads, prints or stores one, and does not
require one to install. Model routes are never invented: with no model supplied,
none is written.

Reports that show the installer writing outside the target tree, altering a
`package.json` key other than `ace`, overwriting a memory file, or acting without
`--force` where it should have refused are treated as vulnerabilities.
