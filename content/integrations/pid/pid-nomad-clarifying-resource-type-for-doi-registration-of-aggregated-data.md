+++
title = "NOMAD – Clarifying Resource Type for DOI Registration of Aggregated Data"
date = 1970-01-01
[extra]
key_article = "pid-nomad-clarifying-resource-type-for-doi-registration-of-aggregated-data"
basic_service = "PID"
status = ""
inc_start = ""
inc_end = ""
inc_cycle = 0
inc_partner_publications = 0
linked_partners = 1
linked_entities = 1
partners = ["FAIRmat"]
entities = ["Humbold University Berlin"]
+++

This use case analyses how NOMAD “Projects” (aggregations of uploaded files, directories, and derived entries) should be represented in the DataCite Metadata Schema for DOI registration. Our analysis showed that these “Projects” function as curated collections of heterogeneous research objects (nested files, heterogeneous data types, derived entries). They are not project descriptions in the sense of RAiDs, but structured aggregations of multiple items that are bundled and assigned a DOI. On that basis, the recommended resourceTypeGeneral is Collection rather than Dataset or Project. We therefore supported NOMAD in clarifying what exactly is being identified, how those aggregated objects should be described, and how the associated metadata can be enriched in a structured and interoperable way.

## Goals

- **Labels:** Metadata analysis, Resource type clarification
- **Resource types:** collections (recommended for NOMAD Projects)
- **PID providers:** DataCite
- **Research field:** materials science, computational materials research

## Partners & entities

- **NFDI consortia:** FAIRmat 
- **Participating entity:** Humbold University Berlin
