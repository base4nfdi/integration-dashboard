+++
title = "Open Energy Platform"
date = 2025-07-31
[extra]
key_article = "iam-open-energy-platform"
basic_service = "IAM"
status = "Finished"
inc_start = "2025-02-01"
inc_end = "2025-07-31"
inc_cycle = 3
inc_cycle_label = "Cycle 3"
inc_partner_publications = 0
linked_partners = 1
linked_entities = 0
partners = ["NFDI4Energy"]
logo_project = "img/partner-logos/6d20ebd08f1e9754.png"
inc_activity_type = "Development"
inc_caai = "regapp"
inc_ownership = "AGPL-3.0-or-later https://github.com/OpenEnergyPlatform/oeplatform/tree/master?tab=License-1-ov-file"
inc_activity_page = "https://openenergyplatform.org"
source_ref = "oep-2"
+++

With this incubator process, we (NFDI4Energy) want to commit to a specific CAAI solution, namely Reg-APP, and integrate it on the OpenEnergyPlatform (OEP). NFDI4Energy is committed in reusing already existing solutions and platforms. As a result, the OEP will serve as one of the main bases for further developments in Research Data Management in the Energy domain and will be a linking and collection point for further NFDI4Energy services. The OEP currently consists of a simple local login (E-Mail and Password) based on basic services available through the python package Django with a PostgreSQL database and simple fronted technology (HTML, JavaScript, CSS). To add Reg-APP support we plan to use the django-allauth module, which supports SAML as well as OpenID Connect.


## Goals

- Integrate RegAPP on the OpenEnergyPlatform as the primary Authentication Service
- Transfer or map existing user accounts, since we plan to maintain the legacy login as well as the RegAPP login
- Operate the OEP and associated services under real environment conditions. As the OEP is a community service we think that a connection to the NFDI Infra proxy will not be necessary
- The served user base will be a mix of researchers, industry partners and society. As such an authentication method that is not based on the research infrastructure needs to be supported, as well

## Results

- [https://github.com/orgs/OpenEnergyPlatform/projects/40](https://github.com/orgs/OpenEnergyPlatform/projects/40)
- [https://openenergyplatform.org](https://openenergyplatform.org)

## Ownership & utilisation

AGPL-3.0-or-later https://github.com/OpenEnergyPlatform/oeplatform/tree/master?tab=License-1-ov-file

## Partners & entities

- **NFDI consortia:** NFDI4Energy

