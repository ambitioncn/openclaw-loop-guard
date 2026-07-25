# Loop Guard v0.2.1

Publishing correction for the v0.2 cloud-failover release.

Runtime behavior is unchanged from v0.2.0. This patch version works around a ClawHub publish transaction that reserved `0.2.0` after rejecting a reserved topic, while leaving that version unavailable.
