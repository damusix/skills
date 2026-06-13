# Skill Optimizer Reference

## Validation Examples

### Python Syntax Validation

```python
import ast

def validate_python(code: str) -> bool:
    """Validate Python code syntax"""
    try:
        ast.parse(code)
        return True
    except SyntaxError as e:
        print(f"✗ Syntax error: {e}")
        return False

# Example
code = '''
import requests
response = requests.get("https://api.example.com/users")
response.raise_for_status()
data = response.json()
'''
validate_python(code)  # Returns True
```

### Command Flag Validation

```bash
# Validate gh command flags
validate_gh_flag() {
    local flag="$1"
    gh pr create --help | grep -q "$flag" && echo "✓ Valid" || echo "✗ Invalid"
}

validate_gh_flag "--title"      # ✓ Valid
validate_gh_flag "--reviewers"  # ✗ Invalid (should be --reviewer)
```

### File Reference Validation

```bash
# Check if referenced files exist
SKILL_DIR="$(dirname path/to/SKILL.md)"

for link in $(grep -oE '\[[^]]*\]\(([^)]+)\)' SKILL.md | cut -d'(' -f2 | cut -d')' -f1); do
    if [[ ! -f "$SKILL_DIR/$link" ]]; then
        echo "✗ Broken reference: $link"
    fi
done
```

### JavaScript Validation

```bash
# Validate JavaScript syntax (requires Node.js)
validate_js() {
    local file="$1"
    node --check "$file" 2>&1 && echo "✓ Valid" || echo "✗ Syntax error"
}
```

## Common Validation Mistakes

| Issue | Example | Fix |
|-------|---------|-----|
| Invalid flag | `gh pr create --reviewers` | Use `--reviewer` (singular) |
| Missing file | `[See GUIDE.md](GUIDE.md)` | Create file or remove link |
| Python syntax | `response = requests.get(url` | Add closing `)` |
| Broken command | `gh repo create --public --confirm` | `--confirm` was removed in gh 2.0; command is now non-interactive by default |

## Recommendation Template

```
## [Action]

Current: [Dimension] X/3 ([Category]: Y%)
Impact: +Z% overall ([Dimension] X→Y)

Before: [current text]
After: [improved text]

Why: [Explain dimension weight and why this helps routing/clarity/etc]
```
