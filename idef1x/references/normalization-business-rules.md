# Normalization as Business-Rule Correctness


Source: Bruce, chapter 9. The framing is the point: normalization is not a math exercise, it is how you record the correct business rules.


## Core framing


- Two slogans = the whole goal: **ONE FACT IN ONE PLACE** and **GET THE BUSINESS RULES RIGHT**.
- Mathematical theory ensures exactly one way to know a fact and controls redundancy. But the business goal is to record the *correct* rules and remove incorrect ones. Theory **helps**; people verify the assertions are true.
- Performance arguments about redundancy in *logical* structures are "a bit questionable" — move the discussion to business rules to make it meaningful.
- **Each denormalization changes the business rules the structure states.** Either the correct rule can no longer be enforced, or enforcement shifts into application code. In any denormalize-or-not debate, argue the business rule, not performance.
- A model can pass every formal normalization rule and still misrepresent the business. **Validate meaning with sample instance tables** — no less important than formal normalization.


## Common design problems (1NF–3NF as rules about facts)


Each is a symptom + the rule it breaks + the fix.

### Repeating attributes — 1NF


A plural attribute holding a list (`childrens-names`). **1NF:** each attribute has exactly one value per instance — atomic, no lists or internal structure. Fix: break the repeating group into a dependent entity. The fix *records new rules* (an employee may have any number of children including none; two children may share a name). Singular names are a large step toward 1NF; a plural name is a red flag.

### Multiple use of the same attribute (overloading)


One attribute carries one of two facts (`start-or-termination-date`). You can't tell which fact it holds and can't record both. A `date-type` discriminator is **not** a fix. This is a definition error, not a classic NF violation, but still wrong. Fix: separate attributes for separate facts. Rule: **every attribute has a single meaning.**

### Multiple occurrences of the same fact — 2NF


A non-key attribute depends on only *part* of a composite key (`employee-address` on a CHILD keyed by `employee-id` + `child-id`). It asserts an employee has as many addresses as children. **2NF:** each non-key attribute carries a fact about the **whole** key. Fix: move the attribute to the entity its fact is about.

### Transitive dependency — 3NF


A non-key attribute determined by another non-key attribute (`city-tax-rate` determined by `city`, both on EMPLOYEE — it wrongly lets the rate vary per employee). Also covers derived attributes (`age` from `birth-date`). **3NF:** a non-key attribute depends on the whole key and on no other non-key attribute. Distinction: 2NF violation = a fact determined by knowing *part of the key*; 3NF violation = a fact determined by knowing *some non-key attribute*.

### Conflicting facts


An attribute about entity X stored on entity Y, producing contradictory duplicates (`emp-spouse-address` on CHILD → different values across a parent's child rows). The fact is about the SPOUSE. Fix: break SPOUSE into its own entity — which may *reveal* the real semantics (two spouses, one current).

### Missing information


A needed fact has no home, or the home forces a wrong rule. Surfaces while building sample instance tables. Watch for wrong rules introduced by the fix attempt (forcing a child's two parents to not both be employees; forcing a person to be either employee or spouse but not both). Worked resolution: a CHILD is not a relationship, it **is a PERSON** — model parentage with a recursive PERSON-ASSOCIATION (two role-named FKs + an `association-type` discriminator). New association kinds (adoption, guardian) then need only a new discriminator value.

### Incorrect business rules — the limit of algorithms


A normalization algorithm works only from the *shape* of the model, with no understanding of meaning. It cannot know CHILD and PERSON are the same concept. It *can* flag two similar relationships and make you think — "that's all we can expect from a normalization algorithm." This is where people take over: removing what is wrong is mostly **correcting business rules**, not applying theory.


## Hidden errors (the hard ones in large models)


The hardest errors involve multiple paths to the same fact or a single path to different facts — both supplied by **relationships**.

### Unwanted unification


Unification merges contributed FKs into one, forcing different paths to reach the *same* instance. It sneaks in when two migrating keys share a name and you **forget role names** — two paths to one instance silently collapse, changing the rule (e.g. "the assisting employee must be the same individual as the negotiating employee"). Diagnostic: wherever unification occurs **without an explicit declaration, stop and ask why, and whether it is correct.** Prevention: role-name migrating keys whenever the same key arrives by more than one path and the paths must stay distinct.

### Errors introduced by surrogate keys


Surrogates usefully shorten composite keys but can **remove** a unification that encoded a real rule — because the original key is no longer contributed across the relationship. The lost assertion ("operator and terminal must be on the *same* transaction") then cannot be restated in basic IDEF1X; role names won't recover it. Surrogates both hide existing errors and introduce new ones; use with great care.

### Overuse of group attributes


If a contributed FK has the same name as a **constituent** of a group attribute, it unifies into the group and seems to **disappear** from the model. Diagnostic: inspect every entity containing a group attribute for unwanted unification inside the group.


## Find-hidden-errors checklist


- [ ] Singular names everywhere; flag any plural (1NF smell).
- [ ] Every attribute carries one fact with one meaning (overloading check).
- [ ] Every non-key attribute depends on the whole key (2NF) and on nothing but the key (3NF).
- [ ] No derived/computable attribute stored beside its source (or it's documented as derived).
- [ ] Every unification: was it declared? If not — why, and is it correct? Role names present where paths must stay distinct.
- [ ] Every surrogate key: did it silently remove a unification that encoded a rule? Can the rule still be stated?
- [ ] Every group attribute: does any contributed FK name collide with a constituent and vanish?
- [ ] **Build a sample instance table and read what it asserts** — the master verification technique.
