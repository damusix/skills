---
name: optimize-skill-instructions
description: |
  Review and improve your SKILL.md with actionable recommendations. Reads skill bundle (SKILL.md + related docs), validates syntax, explains rubric, shows before/after scores. Use when reviewing skill quality, improving a skill file, checking skill scoring, making your skill better, or learning the skill rubric. This is the standalone review skill — for the full optimization cycle (review + evals + improve), use the `optimize-skill-performance-and-instructions` skill instead.
---

# Review Best Practices

Improve your SKILL.md using `tessl skill review` plus validation and context: reads your full skill bundle, validates syntax, explains WHY changes help, and catches mistakes before applying.

## How It Works

- Runs `tessl skill review` to get baseline and judge feedback
- Reads full skill bundle for context (SKILL.md + related files)
- Validates syntax before applying changes
- Explains WHY changes improve scores
- Final accuracy check to prevent mistakes

## Guiding Principles

- Unsure about details, domain terms, or best practices → ask the user
- Don't invent code examples, command flags, or workflow steps
- Judge suggestion conflicts with skill's purpose → discuss trade-offs
- Some skills need verbose explanations or specialized structure
- The rubric optimizes for routing, not domain excellence
- When in doubt, confirm with user

## Workflow

### Phase 1: Baseline Evaluation

```bash
tessl skill review <path-to-SKILL.md>
```

Parse output for scores, validation issues, and judge suggestions. Prioritize fixes:
**Critical** (ERRORs) → **High** (missing "Use when...", low actionability/conciseness) → **Medium** (other dimensions) → **Low** (warnings)

### Phase 2: Discover Skill Bundle

Read SKILL.md and list files in its directory. Bundle = SKILL.md + sibling files + referenced files. Check for orphaned files (see Progressive Disclosure section). Use bundle context to improve progressive disclosure.

### Phase 3: Generate Recommendations

For each issue, provide: what to change, why (dimension + score), before/after, impact, educational note explaining WHY it helps. Apply "Don't invent" principle from Guiding Principles—ask user when unsure.

If bundle has reference files (REFERENCE.md, etc.), recommend linking instead of inlining for progressive disclosure.

### Phase 4: Validate Recommendations

**CRITICAL: Validate before applying changes**

Validate Python syntax (`ast.parse`), command flags (check `--help`), file references, and JavaScript (`node --check`). See [references/REFERENCE.md](references/REFERENCE.md) for detailed validation examples and common mistakes.

### Phase 5: Present Recommendations

Show summary with priorities (Critical/High/Medium) and expected improvement. For each: current score, issue, before/after, impact, educational WHY.

**Discuss trade-offs, not just score gains:**
- "This would improve Conciseness but removes domain context—worth it?"
- "The judge suggests X, but it might not fit your skill's purpose—thoughts?"
- Present options when recommendations have trade-offs

Get user approval before applying.

### Phase 6: Apply Changes

Use Edit tool to update SKILL.md. Track applied recommendations and expected impacts.

### Phase 7: Verify Improvement

**Run review again:**

```bash
tessl skill review <path-to-SKILL.md>
```

**Compare scores:**

```
Before: 72% | After: 89% (+17%)
- Completeness: 2/3 → 3/3 (added "Use when..." clause)
- Actionability: 2/3 → 3/3 (added executable code)
- Conciseness: 1/3 → 2/3 (removed verbose explanations)
```

Explain which dimensions improved and their impact on the overall score.

### Phase 8: Final Accuracy Check

Re-run validation from Phase 4 on the updated SKILL.md:
- ✓ Code syntax valid
- ✓ Command flags correct
- ✓ File references exist
- ✓ Description has "Use when..." clause
- ✓ No concepts Claude already knows

Fix any issues, then re-run `tessl skill review` to confirm improvement.

## Progressive Disclosure: Routing Clarity, Not File Count

40 files is excellent IF each link signals WHEN it's relevant. Bad links force agents to open files "just in case."

**The gate: Can the agent decide WITHOUT opening?**
- ✅ "See [AUTH.md] for OAuth flow setup, token refresh, and session management"
- ❌ "See [GUIDE.md] for more details"

If routing is unclear, inlining may be more token-efficient than splitting.

**Check for orphaned files:**

Files in the bundle that are never referenced add bloat without providing value.

```bash
# Find files that exist but aren't linked
ls skill_dir/ | grep -v SKILL.md
grep -oE '\[[^]]*\]\(([^)]+\.md)\)' SKILL.md | cut -d'(' -f2 | cut -d')' -f1
# Compare: files that exist but aren't in the grep output = orphaned
```

**For each orphaned file, recommend:**
- ✅ Link it with clear routing signals: "See [FILE.md] for X when Y"
- ❌ Remove it: "FILE.md exists but is never referenced—remove to reduce tile bloat?"

Don't leave unreferenced files in the bundle. They waste space and confuse maintainers.

## Notes

- Only modifies SKILL.md (reads but doesn't change other bundle files)
- Uses `tessl skill review` for evaluation
- Validates syntax/commands before applying
- For bulk/PR work on external repos, iterate this workflow per skill or automate with a script
