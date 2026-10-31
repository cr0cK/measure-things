# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
<https://github.com/cr0cK/measure-things/security/advisories/new>. Do not open a public issue.

Include the Measure Things version, the GNOME Shell version, the steps to reproduce, and
the impact you observed. You can expect an acknowledgement within a week.

## Scope

Measure Things runs inside GNOME Shell. It reads screen pixels only when you pick a color, and
writes to the clipboard only when you copy a measurement or a color. In scope: anything in this
repository that could capture or leak screen content, or crash GNOME Shell. Vulnerabilities in
GNOME Shell itself belong to the upstream project.
