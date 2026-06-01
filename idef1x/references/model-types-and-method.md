# Model Types and Method


How IDEF1X work is staged, the architecture it serves, and the limits of working backward from an existing system. Source: Bruce, chapters 1–3 and 10.


## Data-centered vs function-centered design


- **Function-centered (traditional):** data is subsidiary to processing; each function tends to *own* its data. Result — poorly integrated systems where sharing means building bridge interfaces.
- **Data-centered (data-driven):** the structure and semantics of data are the foundation. Concentrate on the **things** (entities), their **properties** (attributes), and their **relationships**.
- **The argument:** if you know what the data is, most function is just creating, replacing, using, and deleting that data. Function is volatile; data structure is stable. Restructure functions around the data, not the reverse.
- **Payoff:** highly integrated systems — structures shared across many functions with no bridging and no function owning the data. **Discipline:** it is easier to think "how" than "what"; resist the pull back toward function analysis.


## Three-schema architecture (ANSI/SPARC)


| Schema | What it is | Also called |
|---|---|---|
| **External** | data as a *user* sees it | user view |
| **Conceptual** | data independent of storage or any external format, scoped to span them all | logical model |
| **Internal** | the physical storage structure | storage view |

Why it matters: with a direct program-to-storage mapping, every storage or view change cascades into program changes and the cost of sharing data escalates. The conceptual schema between programs and storage makes sharing maintainable — programs need not change when storage changes. IDEF1X (relational, relationships by shared keys not pointers) is ideally suited to that neutral conceptual view.


## Logical-then-physical, and design for a shared resource


- Separate *what* the system does (logical) from *how* (physical); produce technology-independent designs first.
- **Single-purpose design is the anti-pattern:** tuning a database to the first application that paid for it makes reuse by later applications hard or impossible.
- **Shared resource / single source of truth:** the design is a *compromise* across all access needs, treating every view as equally important. Requires logical-then-physical **plus** a broad, incrementally installable view of requirements, with **tuning postponed**. Shared databases do not happen by accident — the second, third, and fourth applications won't fit unless the first was designed in the context of the whole.


## Relationship to the Zachman framework


Zachman's framework places data modeling in context: **information models are the architectural representation of the *data* dimension** of a system — one dimension alongside the system's functions and their distribution across the business. The framework frames where IDEF1X fits, not the whole system.


## The four model types


Scope (area covered) and level of detail are **independent** axes — these are *types*, not a single decomposition.

| Type | Logical/Physical | Scope | Contains | Purpose |
|---|---|---|---|---|
| **ERD** (Entity Relationship Diagram) | logical | wide | major entities + relationships, sample attributes; keys usually omitted; **many-to-many allowed** | owner's discussion model — not a design |
| **KBM** (Key Based Model) | logical | wide | all entities + all primary keys; sets the boundary of the information requirement; no nonspecific relationships | context for detailed models |
| **FAM** (Fully Attributed Model) | logical | narrow | all attributes, relationships, integrity rules; volumes, access paths | lowest logical level — what the DBA builds from |
| **TM** (Transformation Model) | physical | narrow | the FAM converted to a structure for the chosen DBMS, optimized by capability and access patterns | the physical design; traces back to logical |

Area models (wide) = ERD + KBM. Project models (narrow, one automation effort) = FAM + TM.


## Approaches


- **Top-down** (preferred) — requirements → logical → physical → system.
- **Bottom-up** (reverse engineering, chapter 10) — infer logical from existing physical artifacts; shows "what exists, not necessarily what is wanted." Risky.
- **Middle-out** — narrow requirements driven down and lifted to business context; "can help but doesn't often work well."


## Reverse engineering and its limits


The round trip (reverse-engineer → adjust for new requirements → forward-engineer) is **re-engineering**. A **reverse-engineered data model** describes a current *physical* database; a **reverse-engineered information model** describes the *logical* requirements a current system satisfies, plus inferences about what was wanted. Distinction throughout: data model = physical, information model = logical.

### Levels


| Level | Nature | What you can expect |
|---|---|---|
| **1** | current-system documentation — a physical DBMS model | **guaranteed only to show what *is*** |
| **2** | application-level logical model | a general description of requirements *currently satisfied* — not full correctness |
| **3** | business-level model | basis for *future* models — **unattainable without direct business-client participation**, and rarely fully achieved |

Level-1 sublevels (physical): 1A each record type → an independent entity, no relationships; 1B redefined areas → category entities, multiple-occurrence groups → dependent entities; 1C substitute business names; 1D identify foreign keys and relationships. Level-2 sublevels (logical): 2A normalize, resolve many-to-many into associative entities, complete generalization hierarchies; 2B add business knowledge to test and adjust toward the business view.

### The "Sweet Dreams" caution


Reverse engineering is "too attractive" a substitute for true requirements work; in practice it works for little beyond documenting a current system — and even that is iffy. **A model of what you have is not a model of what you want.** The models rest on assumptions, and the assumptions compound across levels; their source is the past, mistakes included. Results are always suspect. No technical process substitutes for the hard work of designing what the business actually needs.
