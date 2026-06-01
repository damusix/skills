# Names, Definitions, and Domains


A model has three parts: the diagram, the **names and definitions** of entities/attributes, and a natural-language **view description**. The diagram shows how things relate; definitions say what they *are*. A model is incomplete until its data is defined. Source: Bruce, chapters 5 and 6.

Notation convention used throughout: UPPERCASE = entity name; `lowercase in quotes` = attribute name.


## Naming rules


- **Singular always**, for entities and attributes. Singular names let the model read as declarative sentences and name *an instance*, not the collection. A plural attribute (`person's-hobbies`) signals a normalization error.
- **Clear and distinguishing** — communicate what the thing is *and* set it apart from similar things (PERSON vs CUSTOMER vs EMPLOYEE).
- **One name per concept.** Don't give two different things the same name; don't force one name onto two concepts.
- **Prefer business names.** A model describes a business; name things as the business does. If no business name exists (the business never consciously thinks of "address usages"), name the entity for its purpose in the model and move on — don't invent a false business meaning.
- **Define-first when stuck.** If you can't name something, write its definition first; clarifying the concept surfaces the name.
- **Associative entities:** don't name by juxtaposing parents (`PERSON-ADDRESS` implies it *is* a person or address). Name it for what it represents — `PERSON-ADDRESS-USAGE`.


## Definitions


Every entity and attribute must be defined. Use a standard structure:

- **Description** — a clear, concise statement that lets you decide whether something *is or is not* the thing. Good: "A COMMODITY is something that has a value determinable in an exchange." Bad: "A CUSTOMER is someone who buys something from us" (can it be a company? a future prospect?). Avoid over-generality and undefined terms.
- **Business examples** — illustrate, never define. (Peanuts and marbles clarify that a commodity's value need not be money.)
- **Comments** — ownership, status, source, and especially **distinctions** from similar things (PROSPECT vs CUSTOMER).

Other rules:

- **Know when to stop refining.** Over-precise definitions break (`person-name` defined via birth certificate fails for nicknames). Add comments to block wrong readings instead.
- **Beware definitions that use terms needing their own definition** (`account-open-date` = "date the account was opened" — what is "opened"?).
- **Break circularity, and define what a thing *is*, not what you do with it.** PRODUCT = "a tangible thing our company creates and expects to profit from," not "something we offer for sale."
- **Use one shared glossary** for common business terms (date, currency). Defining them inline everywhere guarantees drift.


## Synonyms, homonyms, aliases


| Term | Meaning | Problem |
|---|---|---|
| Synonym | another name for an already-named object | term confusion |
| Homonym | one name/sound for two different objects | name collision |
| Alias | another name common across a business area | context-dependent naming |

At the logical level every entity/attribute has exactly one identifying name. IDEF1X has no formal handling — record synonyms/homonyms/aliases in the definition.


## Domains


A **domain** is the set of values an attribute may take. Two attributes share a domain if it makes sense to **compare** them (two dates yes; a date and a color no; two strings maybe not).

- **Specify a domain for every attribute**, especially codes and identifiers.
- **Go beyond listing values — give each a meaning.** `customer-status: A,P,F,N` is useless; specify A = Active, P = Prospect, F = Former, N = Never. The implementation must enforce that attributes take only values from their domains.
- **Logical vs physical domain.** Logical domain = the *meanings* of the codes; physical domain = the *values* of the codes, one-to-one with the meanings.
- **Domain as explicit entity** — a coded domain *could* be modeled as its own entity with the code migrating in as an FK. Do this **only** when the business keeps the domain's meaning/description in day-to-day use (it must appear on screens/reports). Otherwise keep it as a documented definition; turning every attribute into an FK to a domain entity is unhelpful.
- **Domains encode business rules.** CURRENCY defined as "all world currencies" vs "the subset we trade" is a policy; maintaining the rule means maintaining the CURRENCY instances. Domains can be restricted per role and across a group (e.g. a constraint that the two currency codes in a trade differ).


## Group (composite) attributes


A **group attribute** is an attribute that is a collection of other attributes called constituents; constituents may themselves be groups (the classic bill-of-materials structure). Declared with a role name. Its full definition is **description (what it is) + declaration (what it consists of)**.

- **Describe what it *is*, not its parts.** `gregorian-date` is "a point on the Gregorian calendar," not "year + month + day." Listing constituents tells you what it contains, not what it represents.
- **Composite domain** — the set of allowed *combinations* of constituent values. Valid constituents are not enough: `month = June, day = 31` has valid parts but an invalid combination. Add a constraint over valid combinations.
- **Use** — bundle a large set of migrated FKs under one role name to simplify a diagram. **Cautions:** failing to declare an obvious group hides structure (decomposing `loan-account-number` may reveal a BRANCH entity); and overusing groups hides business-rule errors via unwanted unification (see `normalization-business-rules.md`).


## Derived attributes


An attribute whose value can be computed from others (a total). **Storing one is a normalization error** — it gives two ways to know one fact, which can disagree (stale `age` vs `birth-date`). Pragmatic rule: break it only when you must, and always **record that it is derived and state the derivation algorithm**. Legitimate for costly-to-recompute balances kept correct per transaction, and for MIS/management databases refreshed periodically. Boundary: if you are adding entities just to house derived data, you have crossed into defining user views, not the business model.


## Role names as data types


Several attributes are often defined over the same domain with different definitions (foreign keys playing different roles). Role names distinguish them; the base attribute's role-named occurrences are its "data types." Note IDEF1X "data type" is not an RDBMS data type — Bruce calls the physical representation the **format** to avoid confusion. Cross-role constraints (bought ≠ sold currency) are stated as written business rules, not by the role-name mechanism alone.
