# Generalization and Categorization (Subtypes)


IDEF1X's treatment of "some things are types of other things." Source: Bruce, chapter 7. This is the richest part of the language for stating constraints on which entities may participate in which associations.


## Two directions, one structure


- **Generalization** — a thing *is a type of* a more general thing (a sparrow is a bird).
- **Categorization** — the inverse: a general thing *comes in* types (a bird comes in sparrow, eagle).

Same structure, opposite reading. A subtype **inherits the properties of its generalization** — both attributes and relationships.


## The three new constructs


- **Generic parent (generalization entity)** — the entity at the top of a level of the hierarchy. May be independent or dependent.
- **Category entity (subtype)** — a subset of the generic parent's instances that share attributes or relationships distinct from other subsets. **Always dependent**, because it inherits its key from the parent.
- **Category relationship** — connects parent to category; from the parent's side it is **one-to-zero-or-one** with the implicit verb "is a."


## What the category relationship asserts


- Each generic-parent instance either *is* an instance of a given category or is not.
- Each category instance *is* an instance of the generic parent (every subtype row is also a parent row).
- The discriminator declares constraints over the allowed combinations of category instances.


## The discriminator


An attribute **of the generic parent** whose value determines which category an instance belongs to (e.g. `account-type`). Create one if no natural common attribute exists. Each cluster has its own discriminator; multiple clusters on one parent means multiple discriminators.


## Key migration into subtypes


**The generic parent's primary key always becomes the primary key of each category** (PK and FK at once). This is exactly why a category entity is always dependent.

Rule: you **cannot** substitute an alternate key as a category's PK without destroying the hierarchy — doing so breaks inheritance (subtypes stop inheriting the parent's attributes and relationships). See the key-substitution workaround below for when the business demands different keys per subtype.


## Complete vs incomplete clusters


| Notation | Meaning |
|---|---|
| double underline under the category symbol | **Complete** — the listed subtypes are *all* possible categories; **every** parent instance must be exactly one of them |
| single underline | **Incomplete** — the subtypes do not exhaust the categories; a parent instance may belong to **none** of them |

Example: EMPLOYEE → {male, female} is complete (no parent is neither). EMPLOYEE → {consultant, full-time} is incomplete (an employee may be neither). "Complete" asserts coverage; within one cluster the categories are already mutually exclusive.


## AND / OR / mixed structures


- **OR structure** (one cluster, one discriminator) — an instance is **exactly one** of the categories. Mutually exclusive (an account is checking OR savings OR loan).
- **AND structure** (multiple clusters, multiple discriminators) — an instance may be **several** subtypes simultaneously; each discriminator is an independent yes/no indicator (something may be checking AND savings AND loan).
- **Mixed** — combine clusters: e.g. must be (checking OR savings) AND may also be loan.
- **Multi-level** — a category can itself be a generic parent for a lower cluster (FULL-TIME-EMP → salesperson / manager / clerical). The deeper the structure, the more explicit the statements about allowed instance combinations; test with sample instance tables.

Within a single OR cluster a parent instance maps to **at most one** category (the discriminator's single value enforces it). Across separate AND clusters it maps to one category per cluster independently.


## Forming a hierarchy


1. Start from separate entities that share similarities.
2. Collect the **common** attributes and move them up into the generic parent; subtype-specific attributes stay in the categories.
3. Give the parent a unified key (`checking-account-number`, `savings-account-number` → `account-number`).
4. Create or choose the discriminator.
5. Add the category entities; each inherits all parent properties.

Move an attribute up **only if its definition is identical across all categories** (compare definitions, not names).


## Partial sharing (attribute or relationship common to some but not all categories)


Two options:

- **Leave it in the categories** — give each a unique name, basing their definitions on a shared base attribute / glossary term not shown on the diagram. Preferred for detailed models and when few categories share it.
- **Move it up to the parent** — then the parent attribute is **null** for instances whose discriminator value is a category the attribute did not come from. Allowed because non-key attributes may be null. Preferred in high-level models when most categories share it.

The same dilemma applies to relationships shared by some-but-not-all categories.


## Reasons to form a hierarchy


1. Entities share a common set of **attributes**.
2. Entities share a common set of **relationships** worth showing — inheritance lets only the relevant subtypes participate (a FULL-TIME-EMP has a BENEFIT-ACCOUNT; a CONSULTANT does not).
3. **Communication** — show categories when the business situation requires it, even if the subtypes carry no distinct attributes. A model's job is to communicate.


## Simplifying an unmanageable hierarchy


When a diagram drowns in allowed-association plumbing between two hierarchies' categories, replace the many specific associative entities with **one general associative entity plus a composite domain** (a matrix). Rows/columns are the two discriminators' domains; `–` cells are disallowed combinations; numbered cells map to an `assoc-type` key part whose domain carries the meaning. This states the **same** constraints but moves detail off the diagram into the definitions — better for communication, though the explicit plumbing is better for a programmer enforcing integrity.


## The key-substitution workaround


IDEF1X does not let alternate keys migrate across relationships, including down category relationships. If the business wants each subtype identified by its own AK with different values than the parent PK (`customer-id`, `employee-id`), you cannot achieve it through the category structure.

Workaround: abandon the category structure; replace each category relationship with a **mandatory nonidentifying one-to-zero-or-one ("is a Z") relationship**. The AK can then become the subtype's PK and migrate properly downstream.

Cost: you lose the mutual-exclusivity constraint (the parent can no longer be prevented from being two subtypes at once) and the subtypes **stop inheriting** the parent's attributes and relationships. Those rules must now be enforced by application code and recorded outside the diagram.


## The over-generalization caution


Generalization can go too far. The **two-entity solution** — one generic THING plus one THING-ASSOCIATION self-relationship — is maximally general but "doesn't tell us much." Be leery of it. Do not generalize genuinely unlike things together (PARTY and ANIMAL into one entity is unjustified).

Trade-off: general structures resist change better but are harder to build and maintain, and the diagram can only show *some* of the operative rules — the rest must be recorded by other means. The right level depends on the precision and flexibility the purpose requires.
