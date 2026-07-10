+++
title = "Object Storage"
date = 2026-07-06
[extra]
status = "degraded"
uptime_pct = "97.40"
requests_24h = "45210"
response_time_ms = "210"
last_check = "2026-07-06T14:00:00Z"
blog_slug = "object-storage"
+++

Object Storage provides S3-compatible buckets for research artefacts and large-file transfers.

## Current status

**Degraded performance** — elevated latency on the primary region due to a failing disk array in rack B2. Reads and writes remain available; replication to the secondary site is catching up.

## Recent activity

- Opened incident #INC-2841 for disk replacement
- Throttled non-critical bulk exports to protect hot paths
- Notified incubator leads of expected 15–20% slower PUT operations

## Mitigation plan

1. Replace affected drives during tonight's maintenance window
2. Rebalance shards across remaining nodes
3. Re-run integrity checks on affected bucket prefixes

## Notes

This report maps to row **object-storage** in `data.csv`.
