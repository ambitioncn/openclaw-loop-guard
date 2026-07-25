# Loop Guard v0.2.2

Packaging hardening for the v0.2 cloud-failover release.

- Adds an explicit npm package file allow-list.
- Excludes tests and local inspection reports from published artifacts.
- Avoids a ClawHub static-analysis false positive caused by a redacted authorization-header test fixture.

Runtime behavior is unchanged from v0.2.0.
