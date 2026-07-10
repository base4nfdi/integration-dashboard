+++
title = "Search API"
date = 2026-07-06
[extra]
status = "Finished"
uptime_pct = "99.87"
requests_24h = "18930"
response_time_ms = "55"
last_check = "2026-07-06T14:00:00Z"
blog_slug = "search-api"
+++

The Search API exposes full-text and faceted search over registry content and linked persistence identifiers.

## Current status

Query throughput is above the weekly average, driven by integration tests from the Jupyter incubator. All replicas are in sync.

## Recent activity

- Deployed query-cache tuning for frequent facet combinations
- Added rate-limit headers to public API responses
- Documented new `/v2/suggest` endpoint for autocomplete widgets

## Notes

This report maps to row **search-api** in `data.csv`.
