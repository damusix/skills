---
name: idef1x
description: Use when designing, reviewing, or normalizing an IDEF1X data model, or running a phased information-modeling project — entities, key migration, identifying vs nonidentifying, subtype clusters, domains, and what the notation implies.
---

# IDEF1X Information Modeling


IDEF1X states business rules as a data structure: entities are nouns, attributes adjectives, relationships verbs — and relationships are carried by **keys that migrate from parent to child**, never by pointers. Every structural choice asserts a constraint, so design is making those assertions say what the business means. This skill is a methodology advisor; a separate tool draws the diagrams.


## The prime directive


- **One fact in one place** (the normalization half) and **get the business rules right** (the correctness half). Theory only helps; people verify the assertions are true.
- **Each denormalization changes the business rules the structure states.** Argue the rule that will be lost or pushed into code, not performance.
- Verify by reading the model back as sentences and by **building sample instance tables** — they expose wrong rules that pass every formal check.


## Key migration — the one distinction to get right


The parent's primary key migrates into the child as a foreign key. *Where it lands is the whole meaning:*

| | Identifying (solid line) | Nonidentifying (dashed line) |
|---|---|---|
| FK lands in | child key area (part of child PK) | child data area (non-key) |
| Identification | child can't be identified without parent | child has its own identity |
| Existence | child can't exist without parent | independent unless mandatory |
| FK nullable | never | yes, if optional (diamond on parent) |

An identifying relationship is a deliberate decision that the parent's identity *is part of* the child's. Never assume it; choose it.


## Quick start


To read or judge any relationship: name parent and child, read parent→child with the verb ("a MOVIE has many MOVIE-COPYs"), then ask — can the child exist or be identified without the parent? Yes → nonidentifying (FK in data area); no → identifying (FK in key area). Then confirm the rule that choice asserts is the rule the business actually wants.


## References


Two sources, tagged per file: **[B]** Thomas Bruce's book (construct *semantics*, design heuristics, normalization-as-business-rules) and **[F]** FIPS PUB 184 (the modeling *procedure*). Where they overlap, the process file cross-refs the Bruce files. Load the file matching your decision:

- **[F]** `references/modeling-process.md` — the five-phase method (0 initiation → 1 entities → 2 relationships → 3 keys → 4 attributes), team roles, source material, validation/walk-through, and each phase's decision criteria and checklists.
- **[B]** `references/entities-keys-relationships.md` — entity types, primary-key choice, migration, identifying vs nonidentifying, cardinality (P/Z/N), recursive & nonspecific relationships, role names, unification, surrogate keys, and the "when you see X it implies Y" reading guide.
- **[B]** `references/generalization.md` — subtypes: generic parent, discriminator, complete vs incomplete clusters, AND/OR structures, the key-substitution workaround, over-generalization.
- **[B]** `references/names-definitions-domains.md` — naming, definitions, domains as business rules, group & derived attributes.
- **[B]** `references/normalization-business-rules.md` — normalization as business-rule correctness, the design-problem catalog (1NF–3NF), hidden errors, the find-errors checklist.
- **[B]** `references/referential-integrity.md` — insert/replace/delete rules (Cascade/Restrict/Set Null) per relationship type.
- **[B]** `references/model-types-and-method.md` — ERD→KBM→FAM→TM, three-schema architecture, data-centered design, reverse-engineering limits.
- **[B]** `references/glossary.md` — every IDEF1X term, one line each.
