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
