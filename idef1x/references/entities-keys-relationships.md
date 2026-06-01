# Entities, Keys, and Relationships


The core constructs and what each one asserts. Source: Bruce, chapters 4 and 6, with the surrogate/unification material from chapter 8.


## Base definitions


- **Entity** — a set of like things called instances; a distinguishable person, place, thing, event, or concept about which information is kept. Named with a **singular** noun so the model reads as sentences.
- **Instance** — one occurrence; must have an identity distinct from every other.
- **Attribute** — a property of an entity; one column holds the value of one property.
- **Relationship** — a connection between **exactly two** entities (all IDEF1X relationships are binary). N-ary associations become an associative entity, never a multi-way line.

Maxim: **"No entity without identity."** Every instance is always identified by its primary-key attributes.


## Entity types


Designation is determined purely by **how the entity gets its key**.

- **Independent** (square box) — identified by its own key; depends on no other entity.
- **Dependent** (rounded box) — borrows part of its identity from one or more parents via a migrated key.

Two kinds of dependency, which the relationship type produces:

- **Existence-dependency** — the child cannot exist unless the parent does.
- **Identification-dependency** — the child cannot be *identified* without the parent's key.

Identifying relationships always produce **both**. A mandatory nonidentifying relationship produces existence-dependency alone. An optional nonidentifying relationship produces neither.

Three specialized dependent entities:

- **Characteristic entity** — a group of attributes that occurs many times for one parent and is not directly identified by anything else; **exactly one** identifying parent (e.g. PET of PERSON).
- **Associative (intersection) entity** — inherits its primary key from **two or more** parents; resolves a many-to-many and records facts about the association. The distinguishing rule: characteristic = one identifying parent; associative = more than one.
- **Category entity** — a subtype; see `generalization.md`.


## Keys — types and what each implies


- **Key** — a set of attributes that uniquely identifies an entity.
- **Candidate key** — attributes that *might* serve as the primary key. If any part can be null, it is disqualified from being THE primary key (it may still be a candidate).
- **Primary key (PK)** — the chosen unique identifier; lives in the key area (above the line). Choosing it is a **business policy statement**: the modeler recommends, the business decides.
- **Alternate key (AKn)** — a candidate key not chosen as primary.
- **Inversion entry (IEn)** — a declared access path that does **not** guarantee uniqueness; looking up by it may return zero, one, or many instances.
- **Foreign key (FK)** — a parent's primary key contributed to a child across a relationship.
- **Composite key** — a PK of two or more attributes, possibly including foreign keys.
- **Surrogate key** — a single meaningless invented attribute used as PK; see the surrogate section below.

Every attribute must be **fully functionally dependent on the whole key and nothing else**.


## Rules for choosing a primary key


1. **Stability first.** Pick a value that will not change over the instance's life. An instance takes its identity from its PK value; if the PK changes, it is a different instance.
2. **Keep it small.** Prefer a single attribute. If composite, every part must be non-null for every instance.
3. **Avoid intelligent keys.** No embedded meaning (locations, dates, groupings) — embedded meaning creates a reason to change, which violates rule 1.
4. **Use keys to enforce existence constraints.** Forming a composite key from another entity's PK (an identifying relationship) is how you state "this child cannot exist without that parent." Each part must still obey rules 1–3.
5. **Consider a surrogate** to replace a large composite key — with care (see below).


## Key migration — the central mechanism


When entities are connected, the parent's PK **migrates** into the child as an FK. The parent is on the "one" end; the child is on the "many" end (the dot). Where the migrated FK lands is the whole distinction:

| | Identifying (solid) | Nonidentifying (dashed) |
|---|---|---|
| FK lands in | key area (part of child PK) | data area (non-key) |
| Child is | identification- and existence-dependent | own-identified; existence-dependent only if mandatory |
| Nullable FK | never | yes if optional |
| Optionality | always mandatory | may be optional (diamond on parent end) |

An identifying relationship **carries a business rule** and is an intentional choice — it does not happen by itself, and must never be assumed.


## Cardinality — what each form asserts


The "one" (no-dot) end is always **zero or one**. The dot (many) end defaults to **zero or more**, and qualifiers tighten it:

- (nothing) = zero or more
- **P** = one or more (positive)
- **Z** = zero or one
- **N** = exactly N (e.g. double-entry bookkeeping = exactly 2)

A diamond on the **parent** (non-dot) end of a *nonidentifying* relationship makes the parent optional — "zero-or-one parent" — which is what allows the child's FK to be null. Diamonds exist only on nonidentifying relationships.

One-to-many in both directions is a **many-to-many (nonspecific)** relationship, drawn with dots on both ends. Allowed **only** in an ERD. The goal of detailed modeling is to eliminate every many-to-many by resolving it into two one-to-many relationships through an **associative entity**.


## Resolving many-to-many


Insert an associative entity between the two parents; both parents' keys migrate into it. Key-placement rule that encodes the business rule: a discriminator like `usage-type` goes in the **key area** if a parent may relate to the same child in more than one way (else only one such pairing can be recorded), or the **data area** if only one way is allowed.


## Recursive relationships


A nonidentifying relationship where the same entity is both parent and child (an entity owning instances of itself, e.g. COMPANY owns COMPANY). **Must be nonidentifying** (an identifying recursion would need the key to contain itself). The migrated FK lands in the data area and **must be given a role name** (`owner-id.company-id`) because an attribute cannot appear twice under one name. A diamond is common (a thing may have no parent) but not required; its absence forces a cycle of foreign keys in the data.


## Role names


A **role name** is a new name for a migrated FK that states the role it plays in the child: `role-name.base-name (FK)`. The original is the **base attribute**; the role-named occurrence inherits the base's domain and physical format but has its own definition.

Required when the **same parent's key migrates into one child more than once** — each occurrence needs a distinct role name to disambiguate (and to prevent unwanted unification). Otherwise optional but clarifying. Role names migrate further like any key; a displayed role name reaches back across one link, but the chain can extend across many entities.


## Unification


**Unification** asserts that two or more contributed FKs point to the **same** instance. It is controlled by role names.

- Same FK migrating by two paths with the **same name and no role names** ⇒ the occurrences **unify** (one shared instance). Often correct, often an accident — stop and verify the rule was intended.
- Different role names ⇒ they **do not** unify (the instances may differ).
- Same role name assigned to both ⇒ they unify; if both are already role-named, both chains must trace back to a common base attribute or the model is in error.
- To assert two FKs must hold **different** values, IDEF1X cannot do it graphically — add a written constraint or a composite domain.

Unwanted unification is a top source of hidden errors in large models — see `normalization-business-rules.md`.


## Surrogate keys


A single meaningless attribute assigned as the PK. **Acceptable** when a compound key only records existence-dependencies rather than how the entity is truly identified; then substitute a short surrogate and enforce the dependencies with mandatory nonidentifying relationships. Surrogates remove intelligence from keys and guard against value changes.

**Danger:** substituting a surrogate can *remove the migration of an original key* and thereby silently drop a unification that encoded a real rule — a rule that then can no longer be expressed in basic IDEF1X. Before replacing a compound key, ask whether it *identifies* the entity or merely records dependencies. Use surrogates with great care.


## Reading and verifying


Read parent → child (toward the dot) with the active verb phrase to get a valid English assertion. Verb phrases plus cardinality summarize the embedded rules but are not a precise spec. Verify by reading the model back to its owners and by building **sample instance tables**.


## Reading guide — when you see X, it implies Y


- **Plural attribute name** (`childrens-names`) ⇒ repeating group, 1NF violation. Break it out.
- **An attribute holding one of two facts** (`start-or-termination-date`) ⇒ overloading; you can never record both. Split it.
- **A non-key attribute about only part of a composite key** ⇒ 2NF error and a wrong rule. Move it.
- **Two FKs from the same parent with the same name and no role names** ⇒ silent unification ("these must be the *same* instance"). If unintended, add role names.
- **A surrogate replacing a composite key** ⇒ check what the composite key *meant*; substituting it can silently drop a constraint that can no longer be expressed.
- **A group attribute whose constituent name matches a migrating FK** ⇒ that FK vanishes into the group via unification. Inspect every group.
- **A complete category cluster (double underline)** ⇒ *every* parent instance must be exactly one listed subtype. **Incomplete (single underline)** ⇒ a parent may be none of them.
- **A `Thing` + `Thing-Association` model** ⇒ over-generalization; technically valid, says almost nothing. Be leery.
