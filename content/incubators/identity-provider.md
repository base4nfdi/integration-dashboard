+++
title = "Identity Provider"
date = 2026-07-06
[extra]
status = "Finished"
uptime_pct = "99.98"
requests_24h = "12450"
response_time_ms = "42"
last_check = "2026-07-06T14:00:00Z"
blog_slug = "identity-provider"
+++

The Identity Provider (IdP) handles federated login across Base4NFDI services. At the time of writing, all authentication endpoints are responding normally.

## Current status

SAML and OIDC flows are stable. Token refresh latency remains within the agreed SLO of 100 ms p95. No failed health checks were recorded in the past 24 hours.

## Recent activity

- Rolled out patched session middleware to staging
- Reviewed SP metadata for two new incubator integrations
- Scheduled quarterly key rotation for August 2026

## Notes

This report maps to row **identity-provider** in `data.csv`. Operations team contact: idp-ops@example.org.
