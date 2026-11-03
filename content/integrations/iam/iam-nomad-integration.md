+++
title = "NOMAD Integration"
date = 2025-07-31
[extra]
key_article = "iam-nomad-integration"
basic_service = "IAM"
status = "Finished"
inc_start = "2025-02-01"
inc_end = "2025-07-31"
inc_cycle = 3
inc_cycle_label = "Cycle 3"
inc_partner_publications = 0
linked_partners = 1
linked_entities = 0
partners = ["FAIRmat"]
logo_consortia = "img/partner-logos/f800628bef34deca.jpg"
inc_activity_type = "Consultancy"
inc_caai = "unity"
inc_ownership = "."
inc_activity_page = "https://nomad-lab.eu"
+++

We want to link NOMAD to the NFDI AAI. NOMAD is a web-based research data management (RDM) platform for material science. It integrates a data repository, Electronic Lab Notebook (ELN), and JupyterHub into a unified platform. It is the main service developed and offered by the FAIRmat consortium. NOMAD uses Keycloak as a Single Sign-On (SSO) solution. We operate a single central instance that is used by all NOMAD installations and services. Currently, we only allow users to use NOMAD accounts that were created on this Keycloak instance. NOMAD uses Keycloak primarily for authentication since all rights are managed within the NOMAD application. Therefore, we currently do not see any need for (community) roles, attributes, or similar functionality within NFDI AAI. Technically, we want to realise this integration either via OpenID connect or SAML depending on NFDI AAI capabilities. Since, NFDI AAI and Keycloak already support at least one shared protocol, the integration should be straight forward. Most of the work, will probably be dedicated to test the integration. We might need some assistance in configuring the connection via OIDC or SAML.


## Goals

- Integrate the NFDI AAI as an identity provider for NOMADs central Keycloak instance. This should allow users to login with their existing NFDI AAI identities. A large portion of the ~4000 existing NOMAD users are affiliated with research institutes and Universities in Germany and Europe. Therefore, many of the existing users and potential new users might already hold identities within the 4 proposed NFDI AAI solutions
- Simplify future integrations with other (NFDI) services (within the materials science community and beyond). For this it is necessary that services rely on a shared NFDI AAI solutions
- Evaluate the use of linking different identities belonging to the same individual user

## Results

.
- [https://nomad-lab.eu](https://nomad-lab.eu)

## Ownership & utilisation

.

## Partners & entities

- **NFDI consortia:** FAIRmat (1 linked)

