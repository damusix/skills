---
name: optimize-skill-instructions
description: |
  Review and improve your SKILL.md with actionable recommendations. Reads skill bundle, validates syntax and references, explains rubric, shows before/after scores. Use when reviewing skill quality, improving a SKILL.md file, checking scoring dimensions and quick wins, auditing progressive disclosure and orphaned bundle files, generating improvement recommendations, running a post-edit quality audit, creating approval-gated change proposals, or automating the skill review workflow. For the full optimization cycle (review + evals + improve), use `optimize-skill-performance-and-instructions`.
---

# Review Best Practices

Improve your SKILL.md using `tessl skill review` plus validation and context: reads your full skill bundle, validates syntax, explains WHY changes help, and catches mistakes before applying.

## Guiding Principles

- The rubric optimizes for routing, not domain excellence — some skills legitimately need verbose explanations or specialized structure
- A judge suggestion that conflicts with the skill's purpose should be discussed as a trade-off, not silently applied
- Don't invent rubric dimensions, score deltas, or `tessl skill review` flags — derive them from actual review output

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

Run each validation step and show the output — do not just describe what you would run:
- Python: run `ast.parse` on any Python code blocks and show the output (including any SyntaxError details)
- JavaScript: run `node --check <file>` and show the result
- Commands: consult `--help` output to verify flags are valid
- Files: check that every referenced file path exists
- Frontmatter `description:` field: verify it contains a "Use when..." trigger clause (check the YAML header, not the body)
- Content: flag any concepts the agent already knows (explain nothing obvious)

See [references/REFERENCE.md](references/REFERENCE.md) for examples. When producing an automation script, include each step as executable code (not comments).

### Phase 5: Present Recommendations

**Start with a priority summary table** before individual details:

```
Priority | Recommendation           | Score impact | Dimension
---------|--------------------------|-------------|----------
Critical | Add "Use when..." clause  | +15% overall | Completeness 0→3
High     | Remove HMAC explanation  | +8% overall  | Conciseness 1→2
Medium   | Add retry example        | +5% overall  | Actionability 2→3
```

Then for each recommendation: current dimension score, issue, before/after examples, numeric score impact estimate (e.g. "+8% overall, Actionability 2→3"), and educational WHY.

**Discuss trade-offs, not just score gains:**
- "This would improve Conciseness but removes domain context—worth it?"
- "The judge suggests X, but it might not fit your skill's purpose—thoughts?"
- Present options when recommendations have trade-offs

Frame changes as proposals (e.g., "I recommend X" or "I suggest removing Y") rather than imperative instructions. Get user approval before applying.

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
- ❌ Remove it: "FILE.md exists but is never referenced—remove to reduce plugin bloat?"

Don't leave unreferenced files in the bundle. They waste space and confuse maintainers.

## Notes

- Only modifies SKILL.md (reads but doesn't change other bundle files)
- Uses `tessl skill review` for evaluation
- Validates syntax/commands before applying
- For bulk/PR work on external repos, iterate this workflow per skill or automate with a script
