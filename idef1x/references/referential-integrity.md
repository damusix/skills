# Referential Integrity Rules


How insert, replace, and delete behave per relationship type. Source: Bruce, Appendix D (the IRD / integrity-rule summary). This edition uses exactly three delete-rule options — **Cascade, Restrict, Set Null** — and does not use Set Default or No Effect.


## Framing


- A constraint statement in a model is a business rule governing allowed data states; every constraint must eventually be **enforced in the physical system** — by the DBMS or by application code.
- **Insert** and **replace** rules are stated by the relationship type plus cardinality. Most **delete** rules cannot be stated graphically, so the designer picks an option per relationship and records it as a written rule.
- A **replace** is an insert of an instance with the same primary key (it overrides all attributes), so it is governed by the **insert** rules.
- General insert rule: an instance can be added only if all referenced foreign keys match existing parent instances — *unless* the relationship is nonidentifying with a nullable FK (the diamond).
- A database has referential integrity **iff it contains no unmatched foreign-key values.**


## What each delete rule means (on delete of the parent instance)


| Rule | Behavior |
|---|---|
| **Cascade** | Delete all child instances for which the deleted instance is the parent. Can cascade *up* (delete a parent if the deleted child was its only child). Discards the child facts. |
| **Restrict** | Disallow the delete while any dependent children exist. Use to preserve child facts (e.g. mark the parent obsolete instead). |
| **Set Null** | Set the child's FK to null, breaking the link but keeping the child row. **Only valid for nonidentifying relationships** — an identifying FK is part of the child's PK and cannot be nulled. |

Cascade and Set Null are deliberate **business decisions to discard the historical knowledge** of the relationship.


## Rules per relationship type


### Identifying (Appendix D.1)


- **Insert:** no child may be inserted without a parent (the FK is part of the child PK and cannot be null). Cardinality variants add requirements — at least one child with the parent (P), exactly N children (N), or zero-or-one (Z).
- **Delete of parent:** **Cascade** (delete all children) or **Restrict** (disallow while children exist).
- **Delete of child:** by cardinality, **Cascade up** (delete the parent if this was its only child) or **Restrict** (disallow deleting the last child).
- **No Set Null** — the FK is in the child's primary key.


### Nonidentifying (Appendix D.2)


- **Insert:** a child may be inserted without a parent **only if** the FK is set to null (the diamond / zero-or-one parent); otherwise no child without a parent.
- **Delete of parent:** **Cascade**, **Restrict**, or **Set Null** (null the FK in all such children). Set Null is the rule unique to nonidentifying relationships.
- **Delete of child** (when FK not null): Cascade / Restrict / Set Null combinations apply.


### Complete category cluster (Appendix D.3)


- **Insert:** inserting the parent must be accompanied by inserting **one** subtype with the same key, plus a discriminator value on the parent. No subtype may be inserted without a parent whose discriminator has the correct value, and the sibling subtype with the same key must be absent (every parent is exactly one subtype).
- **Delete of parent:** **Cascade** down (delete its subtype instance).
- **Delete of subtype:** **Cascade up** (delete the parent with it) or **Restrict**.


### Incomplete category cluster (Appendix D.4)


Same Cascade-down / Cascade-up / Restrict pattern as the complete cluster, with one difference: the parent may legitimately exist with **no** subtype instance (the discriminator may indicate "none").


## Key distinctions


- **Set Null is exclusive to nonidentifying relationships** — its FK is non-key and therefore nullable.
- **Identifying and category** relationships use only Cascade/Restrict, because the contributed key is part of the child's identity.
- **Category insert rules additionally enforce the discriminator value and subtype mutual exclusion.** Complete vs incomplete differ only in whether every parent must have a subtype instance.
