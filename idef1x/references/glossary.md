# IDEF1X Glossary


One-line definitions of the core terms. Source: Bruce, book glossary.


## Entities and attributes


- **Entity** — a distinguishable person, place, thing, event, or concept about which information is kept (a set of like instances).
- **Instance** — a single occurrence of an entity.
- **Attribute** — a property of an entity.
- **Independent entity** — an entity that does not depend on any other for its identification.
- **Dependent entity** — an entity that depends on one or more others for its identification (its PK contains foreign keys).
- **Characteristic entity** — a group of attributes that occurs many times for an entity and is not directly identified by anything else; a dependent entity with **exactly one** identifying parent.
- **Associative entity** — an entity that inherits its primary key from **two or more** associated entities.
- **Generic parent** — the entity at the top of a level of a generalization hierarchy.
- **Category entity** — a subset of a generic parent's instances sharing distinct attributes/relationships; always dependent; inherits all of the parent's properties.


## Keys


- **Key** — see primary, alternate, foreign key.
- **Primary key** — the attribute(s) chosen as the unique identifier of an entity.
- **Candidate key** — attribute(s) that might be chosen as a primary key.
- **Alternate key** — a candidate key not chosen as the primary key.
- **Foreign key** — a parent's primary key contributed to a child across a relationship.
- **Composite key** — a primary key of two or more attributes, possibly foreign keys.
- **Inversion entry** — attribute(s) frequently used to *access* an entity but which may not yield exactly one instance (a non-unique access key).
- **Surrogate key** — a single meaningless attribute assigned as the primary key.


## Relationships


- **Relationship** — a connection between two entities in which each primary-key attribute of the parent becomes a foreign-key attribute of the child.
- **Identifying relationship** — all of the parent's primary-key attributes become part of the **child's primary key**.
- **Nonidentifying relationship** — the parent's primary key becomes a **non-key** foreign key in the child.
- **Nonspecific relationship** — a presentation-style many-to-many relationship contributing no foreign keys; allowed only in an ERD.
- **Recursive relationship** — a nonidentifying relationship in which the same entity is both parent and child.
- **Category relationship** — connects a generic parent to a category ("is a"); defined via category entity, discriminator, and generalization hierarchy.
- **Child entity** — the entity to which a relationship contributes a foreign key (the "many" end).
- **Descendent** — an identification-dependent entity.


## Structure and rules


- **Domain** — the set of values an attribute may take.
- **Category discriminator** — an attribute that determines which category a generic-parent instance belongs to.
- **Generalization hierarchy** — a hierarchical grouping of entities sharing common characteristics; lower entities are types of the higher one (= category / subtype hierarchy).
- **Role name** — a new name for a foreign key defining the role it plays in the child; its domain must be a subset of the foreign key's domain.
- **Group attribute** — an attribute that is a collection of other attributes (constituents).
- **Migration (propagation)** — the movement of a primary key from a parent to a child across a relationship.
- **Unification** — the merging of two or more foreign keys into one, asserting their values must be identical.
- **View** — a subset of an information model.
- **Null** — having no value.
- **Referential integrity** — the guarantee that no unmatched foreign-key values exist.
- **Cascade** — deleting an instance simultaneously deletes all instances dependent on it for existence.
- **Restrict** — a delete will not occur while other instances depend on the target.
- **Nullify (Set Null)** — a process that sets a foreign key to null.
