+++
title = "NFDI AAI for the NFDI4ING Jupyter Service"
date = 2026-07-31
[extra]
key_article = "iam-nfdi4ing-jupyter"
basic_service = "IAM"
status = "Finished"
inc_start = "2026-02-01"
inc_end = "2026-07-31"
inc_cycle = 5
inc_partner_publications = 0
linked_partners = 1
linked_entities = 0
partners = ["NFDI4Ing"]
logo_consortia = "img/partner-logos/a755e82e7aec255a.svg"
inc_activity_type = "Development"
inc_caai = "regapp"
inc_ownership = "CC-BY 4.0"
inc_activity_page = "https://jupyter.nfdi4ing.de"
+++

The jupyter service is actually connected via SAML to the EDUGAIN federation. We use apache_mod_shib to provide the necessary attribute to our login application. We want to understand the architecture of NFDI AAI, the meaning of community AAIs, infrastructure proxies and virtual organisations to be able to plan and implement the necessary steps to connect our service to the NFDI AAI infrastructure. So far, we are not able to configure our service using the existing documentation. We hope to get the knowledge we need within this incubator project, learn form experiences from others and also help to ease this process for other services. In order to do so, we have to perform the following steps: - Clarification of requirements and necessary steps to connect a service to NFDI AAI (AAI4NFDI team together with project team) - Selection of the community AAI (project team) - Clarification of the process how and where to define user groups (like engineers) (AAI4NFDI team together with project team) - Implementation of integration of NFDI AAI (project team with support of NFDI4AAI team) - Plan how to migrate existing users (project team with support of NFDI4AAI team)


## Timeline

- **Start:** 2026-02-01
- **End:** 2026-07-31

## Goals

- Ease the onboarding of new institutions/user groups to our service
- Allow users outside academia (EDUGAIN) to login into our service (like federal research organisations)
- Allow to confine the access to the service to selected user group

## Results

- [https://github.tik.uni-stuttgart.de](https://github.tik.uni-stuttgart.de)
- [https://jupyter.nfdi4ing.de](https://jupyter.nfdi4ing.de)

## Ownership & utilisation

CC-BY 4.0

## Partners & entities

- **NFDI consortia:** NFDI4Ing 

