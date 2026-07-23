+++
title = "NFDI AAI for the NFDI4ING Jupyter Service"
date = 1970-01-01
[extra]
key_article = "iam-nfdi4ing-jupyter"
basic_service = "IAM"
status = "Running"
inc_start = ""
inc_end = ""
inc_cycle = 5
inc_partner_publications = 0
linked_partners = 1
linked_entities = 0
partners = ["NFDI4Ing"]
logo_consortia = "https://nfdi4ing.de/wp-content/uploads/2024/09/Logo_24.svg"
+++

The jupyter service is actually connected via SAML to the EDUGAIN federation. We use apache_mod_shib to provide the necessary attribute to our login application. We want to understand the architecture of NFDI AAI, the meaning of community AAIs, infrastructure proxies and virtual organisations to be able to plan and implement the necessary steps to connect our service to the NFDI AAI infrastructure. So far, we are not able to configure our service using the existing documentation. We hope to get the knowledge we need within this incubator project, learn form experiences from others and also help to ease this process for other services. In order to do so, we have to perform the following steps: - Clarification of requirements and necessary steps to connect a service to NFDI AAI (AAI4NFDI team together with project team) - Selection of the community AAI (project team) - Clarification of the process how and where to define user groups (like engineers) (AAI4NFDI team together with project team) - Implementation of integration of NFDI AAI (project team with support of NFDI4AAI team) - Plan how to migrate existing users (project team with support of NFDI4AAI team)

NFDI AAI for the NFDI4ING Jupyter Service is an incubator project within the **Identity and Access Management (IAM)** basic service of Base4NFDI.

## Current status

**Running** — cycle 5.

## Timeline

- **Start:** —
- **End:** —
- **Cycle:** 5

## Goals

- Ease the onboarding of new institutions/user groups to our service
- Allow users outside academia (EDUGAIN) to login into our service (like federal research organisations)
- Allow to confine the access to the service to selected user group

## Partners & entities

- **NFDI consortia:** NFDI4Ing (1 linked)
- **Partner publications:** 0

## Notes

This report maps to row **iam-nfdi4ing-jupyter** in the NocoDB dashboard table.
