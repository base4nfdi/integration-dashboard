+++
title = "NFDI AAI for DALIA"
date = 2025-07-31
[extra]
key_article = "iam-nfdi-aai-for-dalia"
basic_service = "IAM"
status = "Finished"
inc_start = "2025-02-01"
inc_end = "2025-07-31"
inc_cycle = 3
inc_partner_publications = 0
linked_partners = 0
linked_entities = 0
logo_consortia = "https://incubators.nfdi-aai.de/images/dalia-logo.png"
+++

DALIA is a search platform for teaching and learning resources on RDM and data literacy. Its intended purpose is to offer a single point of entry to search and access open educational resources (OER) published by NFDI’s consortia and sections and by third parties. The integration of the DALIA platform with IAM4NFDI will strengthen the connection to the NFDI and RDM communities and will offer a seamless authentication flow for DALIA’s users. The DALIA platform consists of a Django-based backend application server and a frontend web application based on the Next.js framework. The authentication library we plan to use in DALIA’s backend is django-allauth which supports various social authentication flows and protocols, in particular a general OIDC provider. The library’s new headless feature (https://docs.allauth.org/en/latest/headless/index.html) will be used to provide a REST-based authentication flow for DALIA’s frontend. Additionally, we envision to process attributes from IAM4NFDI’s Core Attribute Profile to populate our users’ profiles. We can reuse findings and solutions by other projects and IAM4NFDI incubators on the integration of NFDI AAI into Python web projects:

NFDI AAI for DALIA is an incubator project within the **Identity and Access Management (IAM)** basic service of Base4NFDI.

## Current status

**Finished** — cycle 3 completed on 2025-07-31.

## Timeline

- **Start:** 2025-02-01
- **End:** 2025-07-31
- **Cycle:** 3

## Goals

- Addition of an NFDI AAI login to DALIA’s search portal by integration of the NFDI Infrastructure Proxy as an OIDC provider
- Users can login at the DALIA search portal via the NFDI AAI, in particular by using their Home-IdP
- Become an overarching NFDI base service, thus it should connect to the NFDI AAI infrastructure via the Infrastructure Proxy

## Results

- [https://git.rwth-aachen.de/dalia/backend/django](https://git.rwth-aachen.de/dalia/backend/django)

## Partners & entities

- **Partner publications:** 0

## Notes

This report maps to row **iam-nfdi-aai-for-dalia** in the NocoDB dashboard table.
