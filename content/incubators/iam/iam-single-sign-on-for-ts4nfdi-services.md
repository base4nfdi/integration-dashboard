+++
title = "Single-Sign-On for TS4NFDI services"
date = 2026-07-31
[extra]
key_article = "iam-single-sign-on-for-ts4nfdi-services"
basic_service = "IAM"
status = "Running"
inc_start = "2026-02-01"
inc_end = "2026-07-31"
inc_cycle = 5
inc_partner_publications = 0
linked_partners = 0
linked_entities = 0
logo_consortia = "https://incubators.nfdi-aai.de/images/TS4NFDI-small-grey.svg"
+++

The incubator project aims to implement a Single Sign-On (SSO) solution for Terminology Services 4 NFDI (TS4NFDI), which provides cross-domain services for terminology provision, curation, development, harmonization, and mapping. The platform integrates standardized services including a centralized API Gateway, NFDI-wide Mapping Service, and Terminology Service Suite widgets, all accessible through a central Service Portal for unified collection and mapping management. The planned Authentication and Authorization Infrastructure (AAI) will support login via NFDI-AAI, ORCID, and GitHub, with compatibility for EOSC AAI. The API Gateway provides database access for all services, enabling storage of user-specific configurations and collections. Beyond current data provision, TS4NFDI will support terminology curation workflows where logged-in users can suggest extensions through graphical interfaces, automatically generating GitHub issues or pull requests with ORCID identifiers for proper curator review and contribution credits. The TS4NFDI Mapping Service, implemented using Cocoda software, will be extended from its current ORCID and GitHub authentication to include NFDI AAI login capabilities. Given discussions about integrating TS4NFDI into the NFDI EOSC node, the AAI solution is designed for EOSC AAI infrastructure compatibility.

Single-Sign-On for TS4NFDI services is an incubator project within the **Identity and Access Management (IAM)** basic service of Base4NFDI.

## Current status

**Running** — cycle 5, started 2026-02-01.

## Timeline

- **Start:** 2026-02-01
- **End:** 2026-07-31
- **Cycle:** 5

## Goals

- Integrate RegApp to the API Gateway as the primary authentication service
- The following services should be connected to the authentication service: TS4NFDI Service Portal, TS4NFDI Mapping Service and the Terminology Service Suite

## Results

- [https://terminology.services.base4nfdi.de/](https://terminology.services.base4nfdi.de/)
- [https://github.com/ts4nfdi/api-gateway](https://github.com/ts4nfdi/api-gateway)
- [https://github.com/ts4nfdi/service-portal](https://github.com/ts4nfdi/service-portal)
- [https://github.com/ts4nfdi/terminology-service-suite](https://github.com/ts4nfdi/terminology-service-suite)
- [https://github.com/gbv/cocoda](https://github.com/gbv/cocoda)
- [https://github.com/gbv/login-server](https://github.com/gbv/login-server)

## Partners & entities

- **Partner publications:** 0

