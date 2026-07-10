+++
title = "Backup Service"
date = 2026-07-06
[extra]
status = "maintenance"
uptime_pct = "—"
requests_24h = "0"
response_time_ms = "—"
last_check = "2026-07-06T14:00:00Z"
blog_slug = "backup-service"
+++

The Backup Service performs scheduled snapshots and off-site replication for critical platform data.

## Current status

**Planned maintenance** — backup agents are paused while the tape library firmware is upgraded. No new backup jobs are accepted until maintenance completes.

## Maintenance window

- Start: 2026-07-06 12:00 UTC
- Expected end: 2026-07-06 18:00 UTC
- Impact: delayed backups only; restores from existing snapshots remain available

## Recent activity

- Pre-maintenance verification of last full backup checksums
- Communicated window to all service owners
- Prepared rollback image for library controller

## Notes

This report maps to row **backup-service** in `data.csv`.
