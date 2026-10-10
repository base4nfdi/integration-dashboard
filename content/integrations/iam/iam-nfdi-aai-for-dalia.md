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
logo_consortia = "img/partner-logos/764ee5bf54a00a8d.png"
inc_activity_type = "Development"
inc_caai = "Infraproxy"
inc_ownership = "MIT License"
inc_activity_page = "https://dalia.education"
+++

DALIA is a search platform for teaching and learning resources on RDM and data literacy. Its intended purpose is to offer a single point of entry to search and access open educational resources (OER) published by NFDI’s consortia and sections and by third parties. The integration of the DALIA platform with IAM4NFDI will strengthen the connection to the NFDI and RDM communities and will offer a seamless authentication flow for DALIA’s users. The DALIA platform consists of a Django-based backend application server and a frontend web application based on the Next.js framework. The authentication library we plan to use in DALIA’s backend is django-allauth which supports various social authentication flows and protocols, in particular a general OIDC provider. The library’s new headless feature (https://docs.allauth.org/en/latest/headless/index.html) will be used to provide a REST-based authentication flow for DALIA’s frontend. Additionally, we envision to process attributes from IAM4NFDI’s Core Attribute Profile to populate our users’ profiles. We can reuse findings and solutions by other projects and IAM4NFDI incubators on the integration of NFDI AAI into Python web projects:

## Goals

- Addition of an NFDI AAI login to DALIA’s search portal by integration of the NFDI Infrastructure Proxy as an OIDC provider
- Users can login at the DALIA search portal via the NFDI AAI, in particular by using their Home-IdP
- Become an overarching NFDI base service, thus it should connect to the NFDI AAI infrastructure via the Infrastructure Proxy

## Results

- [https://git.rwth-aachen.de/dalia/backend/django](https://git.rwth-aachen.de/dalia/backend/django)
- [https://dalia.education](https://dalia.education)

## Ownership & utilisation

MIT License

## Partners & entities
