# The IDEF1X Modeling Process


**Source: FIPS PUB 184** (NIST, *Integration Definition for Information Modeling — IDEF1X*, 1993), Annex A — the original ICAM modeling procedure. This file is the **how-to-run-a-modeling-project** layer. For the *semantics* of the constructs it produces (what an identifying relationship means, subtype clusters, domains, normalization-as-business-rules), see the Bruce-sourced files — they are cross-referenced inline as [Bruce]. Where the two sources agree, that is noted.


## Why model data (objectives)


Manage the **meanings applied to facts**, not the data itself — a fact with no meaning is worthless, a fact with the wrong meaning is dangerous. Information is data aggregated for a purpose, so you cannot control it by limiting creation; you control it by controlling the underlying meanings. Stated objectives of a semantic data model:

- **Plan data resources** — an enterprise-wide view to scope projects that build shared data.
- **Build shareable databases** — an application-independent, user-validated view, transformable to a physical design for any DBMS.
- **Evaluate vendor software** — check a package against the model to expose mismatches with how the business actually works.
- **Integrate existing databases** — model existing systems to derive one integrated conceptual schema.

(The three-schema grounding — external / conceptual / internal — is covered in [Bruce] `model-types-and-method.md`; FIPS shares it.)


## The five phases


An orderly progression: project planning → data collection → entities → relationships → keys → nonkey attributes → validation → acceptance. Each phase produces review **kits** (below). The phases below are the load-bearing technique.


## Phase Zero — Project Initiation


Define the model by both its **limitations and its ambitions**. Products: a project definition, a source-material plan, and author conventions.

- **Modeling objective = two statements.** A *statement of purpose* (the model's concerns) and a *statement of scope* (its functional boundaries). Decide **AS-IS** (current) vs **TO-BE** (intended future) up front. Bound scope by a type of user, a business function, or a type of data. Example: "define the current (AS-IS) data used by a manufacturing-cell supervisor to make and test composite aircraft parts." Even when scope is one user type, involve other users so the view stays unbiased.
- **Modeling plan** — tasks + sequence + milestones, following the canonical task order above.
- **Team roles** (durable principle, governance kept light): a **project manager** (administrative control, supplies sources/experts, chairs the acceptance committee); a **modeler** (applies the technique, records the model, reports to the PM — *not* the committee, to keep recording unbiased); **sources** (people or documents giving raw, inherently partial views — people beat documents because they can explain use); **subject-matter experts** (review evolving model portions; their comments are themselves source material); an **acceptance review committee** (experts + informed laymen, passes final judgment). One person may hold several roles, but too few viewpoints yields a narrow model. The modeler must **not** sit on the committee (conflict of interest).
- **Collect source material** — interviews, observation, policies/procedures, existing system inputs and outputs, file/DB specs. **Mark every artifact so it traces back to its source**; that trace is used as evidence in every later phase. Source docs are biased toward *use* (external or internal schema) and must map to the neutral conceptual schema — and the finished model must map back.
- **Author conventions** — declared latitudes (e.g. a naming convention) that improve presentation and review; document each as adopted.

**Validity criterion:** a model is valid when an **informed consensus of experts agrees it appropriately and completely represents the area** — not when it is "right" in the abstract. Models are assumed invalid until proven otherwise; record dissents.


## Phase One — Entity Definition


Objective: identify and define the entities in the problem domain. Products: the **entity pool** and the start of the **entity glossary**.

- **Identify entities — heuristics over the source-material name list:** find the **nouns** (part, vehicle, drawing); scan for terms ending in **'code'/'number'** (the phrase preceding it is a candidate entity); then apply the test — *is this an object information is known **about**, or is it information **about** an object?* Objects-known-about are viable entities.
- **Screen each candidate:** (a) can it be described / does it have qualities? (b) are there several instances? (c) can one instance be told from another? (d) does it *describe* something else? — a yes to (d) means it is an **attribute**, not an entity.
- **Entity pool** — every entity name known so far, each with a source reference and optional ID number. It **evolves**: names drop out and new ones are added through Phase Four; keep it current.
- **Define entities** — entity name + definition (the one *used in the enterprise*, scoped to the Phase Zero viewpoint — not a dictionary entry) + aliases (the definition must apply exactly to each alias). The act of defining is what forces the team toward a single accepted meaning per term. Technique: **define the easiest entities first** to build glossary volume fast, then research the hard ones.


## Phase Two — Relationship Definition


Objective: identify and define the basic relationships. Products: a **relationship matrix**, relationship definitions, entity-level diagrams.

- **Binary only.** IDEF1X relationships connect exactly two entities; any n-ary association is expressed as n binary relationships. (Shared with [Bruce].)
- The aim is to express connections as **existence-dependency (parent-child)** relationships: each parent relates to zero/one/more children, each child to exactly one parent, child existence depends on parent. If parent and child are the *same real-world object*, parent = **generic**, child = **category** (a categorization cluster; only one category applies per generic instance). Deeper semantics in [Bruce] `generalization.md`.
- **Relationship matrix** — a grid with all entities on both axes; mark an **X** where a relationship *may* exist. Nature/cardinality is irrelevant here; only "a relationship may exist" matters. This surfaces candidate relationships pairwise.
- **Non-specific (N:M) relationships are allowed now** as placeholders — neither entity depends on the other — to be resolved in Phase Three.
- **Establish dependency by testing cardinality in both directions:** fix one instance of A, count related B; reverse. Zero/one/more at *both* ends → non-specific (resolve later). An **"exactly one"** at one end → specific; that end is the **parent**.
- **Name the relationship** as a verb phrase so it **reads as a true sentence** (an assertion). Specific: read parent→child. Categorization: name omitted ("may be a" is implied). Non-specific: may carry two names, one per direction.
- Avoid **transitive relationships:** if DEPARTMENT→PROJECT and PROJECT→PROJECT-TASK, do not also draw DEPARTMENT→PROJECT-TASK — it is implied. New modelers over-specify; keep the parent-child goal in view.
- **Entity-level diagrams** — plain boxes, no attributes, non-specific relationships permitted; one all-entity diagram is preferred for context. **FEOs** ("For Exposition Only") are informal reference diagrams for modeler↔reviewer discussion, not part of the formal model.


## Phase Three — Key Definitions


The technique-dense core. Objectives: resolve non-specific relationships, identify and define keys, migrate primary keys, validate. Operates at the **key-based level**.

- **Resolve every non-specific relationship** into two specific ones via a new **associative / intersection entity** representing the ordered pair (ROBBER ⋈ BANK → BANK-ROBBERY, related to exactly one of each). **Naming tell:** a natural entity is a *singular common noun*; an intersection entity is typically a *compound noun phrase*. Resolving all N:M is the first rule of entity validity and the first step in stabilizing the structure.
- **Depict function views** — by now the model is too large to hold in one mental image, so split it into **function views**: single diagrams giving a limited, functionally meaningful context reviewable in one sitting. Pick a view's topic from a sample source document or a job/process/department.
- **Identify key attributes** — candidate keys (uniquely identify an instance), the chosen **primary key** (the one that *migrates*; every entity has one), and **alternate keys** (other candidates, never migrated). Start with entities that are not a child or category anywhere — their keys are clearest and they seed migration. Iterate, since some candidate keys only appear after migration.
- **Ownership:** every attribute has exactly **one owner** (the entity where it originates); an entity's attributes are each either owned by it or part of a foreign key in it. (Aligns with [Bruce].)
- **Migrate primary keys — the rules:** migration flows **parent/generic → child/category only**; the **whole** primary key migrates **once per relationship**; **nonkey attributes never migrate**. A category's PK must be identical to the generic's PK. Migrated FK attributes are not owned by the child.
- **Identifying vs non-identifying — the exact rule:** if the child's primary key contains **all** attributes of a foreign key, the child is identifier-dependent and the relationship is **identifying**; if **any** FK attribute is not in the child's PK, it is **non-identifying**. (This is the same distinction framed in [Bruce] `entities-keys-relationships.md`, stated here as a mechanical test.)
- **Role names** — when one attribute migrates into the same child by two paths: if both FKs must hold the same value, the attribute appears once (unified); if values may differ, it appears multiple times, each with a role name (`RoleName.OriginalName`).
- **Validation checklist:**
    - [ ] **No non-specific syntax** — all N:M resolved.
    - [ ] **Migration present** — parent→child PK migration done everywhere required.
    - [ ] **No-Repeat Rule** — no attribute holds more than one value per instance; if it can, split out a new entity.
    - [ ] **No-Null Rule** — no primary-key attribute may ever be null. Corollary: a PK cannot migrate into a child where it would not apply to *every* instance — that forces a new entity or subtype.
    - [ ] **Smallest-Key Rule** — no compound-PK entity can be split into simpler-key entities without losing information (full-functional-dependence test).
    - [ ] **Unification** — when a key migrates by multiple paths and children share one value, the FK appears once; role-name and duplicate only when values may differ. (See [Bruce] `normalization-business-rules.md` for unwanted unification.)
    - [ ] **Dual-path assertions** — when a child reaches a common root parent by two paths, assert **equal**, **unequal**, or **indeterminate** (the default). If one path is a single relationship and the paths are equal, that relationship is **redundant — remove it**.
- **Entity/Attribute matrix** — entities down the side, attributes across the top; cells coded **O**(owner), **K**(primary key), **M**(migrated). The principal tool for tracking attribute distribution and model continuity.
- **Define key attributes only** in this phase (name + definition + aliases), associated with the owner entity.


## Phase Four — Attribute Definition


Objective: the fully-attributed, fully-normalized model. Build the attribute pool, establish ownership, define nonkey attributes, refine.

- **Identify nonkey attributes** — return to the source-data list and extract the **descriptive noun phrases** (mirror of how object nouns became entities). Names rejected as entities are probably attributes; the attribute pool is much larger than the entity pool.
- **Establish ownership** — assign each nonkey attribute to **one owner**; when unclear, trace it to source material and see where its values actually occur — ownership follows the fact. Two normalization rules (this *is* full normalization):
    - **Full-Functional-Dependency (2NF)** — no owned nonkey value may be identified by *less than the entire* primary key. (`PROJECT-NAME` from just `PROJ-NO` of a compound TASK key → belongs to PROJECT.)
    - **No-Transitive-Dependency (3NF)** — no owned nonkey value may be identified by *another* nonkey attribute. (`DEPT-NAME` from inherited `DEPT-NO` → belongs to DEPARTMENT.)
    - Mnemonic: an attribute depends on **the key, the whole key, and nothing but the key.** (Same target as [Bruce] `normalization-business-rules.md`, reached here as ownership rules.)
- **Define attributes** — precise, complete, unique names; prefer natural-English names (programming-constrained names go in as aliases only). A definition may also carry format/data type, the domain (list or range), and multi-attribute assertions (e.g. SALARY > $20,000 when JOBCODE = 20).
- **Refine** — apply the No-Repeat Rule to nonkey attributes too (violations spawn new entities, which must then run through every prior-phase requirement); re-check every ownership against 2NF/3NF. Optionally mark violators in place (e.g. `(R)`) and resolve in a batch.
- Result: a per-entity documentation set — definition, all keys, owned nonkey attributes, every attribute definition, all parent-side and child-side relationships, and any dual-path assertions.


## Documentation and validation


Automated tooling helps (layout, model merge, rule checking, configuration management) but is **not required**.

- **Kits** — a kit is a self-contained reviewable package (diagrams, text, glossary, decision summaries) for one review unit; kit content escalates by phase. **Iron rule: if a kit goes out for written comment, the author must always respond to every comment.** A library function holds the controlled master copy and handles distribution.
- **Kit review loop:** author issues kit → library distributes → commenter writes comments → returns to author's master → author writes reactions → back to commenter → either party may request a discussion. Maturity ratchet advances only by review: **Working → Draft → Recommended → Publication.**
- **Model walk-through** (synchronous alternative) — assemble participants; present the **entity pool first** (the table of contents), then the **glossary** (adopt the team's meanings — do not debate meanings here, a meaning change ripples through every diagram), then function views. Six steps, each with acceptance criteria: (1) scan entity pool, (2) read the function-view diagram, (3) examine key attributes, (4) examine key migration, (5) examine nonkey attributes, (6) set diagram status — Recommended as-is, Recommended as modified, Draft (redraw + re-review), or Not Accepted (re-analyze).
