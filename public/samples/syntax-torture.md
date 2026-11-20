[toc]

# Syntax Torture Test Suite

This document exercises edge cases, boundary conditions, and stress scenarios across CommonMark, GitHub Flavored Markdown (GFM), KaTeX, and Mermaid implementations.

## Setext Headings

Setext Level 1 Heading
======================

Setext Level 2 Heading
----------------------

Another Setext 1 with Trailing Spaces
===

Another Setext 2 Under Single Line Text
---

## Closed ATX Headings

### Closed Heading Level 3 ###

#### Closed Heading Level 4 with Uneven Hashes #

##### Closed Heading Level 5 with Trailing Spaces #####    

## Duplicate Heading Names

### Stress Target Alpha

First occurrence of the identical heading label used to test table of contents collision and anchor deduplication.

### Stress Target Alpha

Second occurrence of the identical heading label. In standard GFM slugification, this must produce `stress-target-alpha-1`.

### Stress Target Alpha

Third occurrence of the identical heading label. Slug generator must output `stress-target-alpha-2`.

## Headings with Inline Code, Links, and Emphasis

### Heading containing `inline_code()` token

Sub-section body following code-bearing heading.

### Heading with [external anchor target](https://commonmark.org) inside title

Sub-section body following link-bearing heading.

### Heading with *emphasis*, **strong text**, and ~~strike~~

Sub-section body verifying inline formatting strip for document outlines.

## Deeply Nested Lists

- Tier 1: System root node
  1. Tier 2: First ordered partition
     - Tier 3: Sub-partition descriptor
       - [ ] Tier 4: Pending configuration task
         1. Tier 5: Atomic instruction leaf alpha
         2. Tier 5: Atomic instruction leaf beta
       - [x] Tier 4: Completed validation task
     - Tier 3: Secondary descriptor
  2. Tier 2: Second ordered partition
     - Tier 3: Tertiary node
- Tier 1: Auxiliary tree root

## Loose versus Tight Lists

Tight list (no inter-item spacing):
- First tight element
- Second tight element
- Third tight element

Loose list (contains paragraph breaks):

- First loose item with explicit paragraph body.

  Additional paragraph nested directly inside the first loose list item.

- Second loose item following an empty line separator.

  Accompanying secondary paragraph block.

## Lists Containing Code Blocks and Quotes

- Item Alpha: encapsulates an indented code block:

      // Indented 4 spaces inside list scope
      fn calculate_checksum(bytes: &[u8]) -> u32 {
          bytes.iter().fold(0u32, |acc, &b| acc.wrapping_add(b as u32))
      }

- Item Beta: encapsulates a fenced code block:

  ```python
  def verify_integrity(manifest: dict) -> bool:
      return all(item.get("valid") for item in manifest.values())
  ```

- Item Gamma: encapsulates a nested blockquote:

  > This blockquote is scoped entirely inside the list item.
  > Continuity is preserved across multi-line wrapped text.

- Item Delta: trailing leaf item returning to list root.

## Nested Blockquotes with Lists

> Top-level blockquote boundary container.
> 
> > Second-tier nested blockquote.
> > 
> > - Nested bullet element inside second tier
> > - Another nested bullet element
> >   1. Ordered element nested within bullet
> >   2. Second ordered element
> > 
> > > Third-tier blockquote reaching maximum nesting depth.
> > > Trailing citation marker inside deepest level.
> 
> Return to top-level blockquote container.

## Wide Twelve Column Table

| Col 01 | Col 02 | Col 03 | Col 04 | Col 05 | Col 06 | Col 07 | Col 08 | Col 09 | Col 10 | Col 11 | Col 12 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Val 1A | Val 2A | Val 3A | Val 4A | Val 5A | Val 6A | Val 7A | Val 8A | Val 9A | Val 10A | Val 11A | Val 12A |
| Val 1B | Val 2B | Val 3B | Val 4B | Val 5B | Val 6B | Val 7B | Val 8B | Val 9B | Val 10B | Val 11B | Val 12B |
| Val 1C | Val 2C | Val 3C | Val 4C | Val 5C | Val 6C | Val 7C | Val 8C | Val 9C | Val 10C | Val 11C | Val 12C |
| Val 1D | Val 2D | Val 3D | Val 4D | Val 5D | Val 6D | Val 7D | Val 8D | Val 9D | Val 10D | Val 11D | Val 12D |

## Table with Code, Escaped Pipes, and Links

| Operation | Escaped Syntax | Sample Code | Documentation Link |
| :--- | :--- | :--- | :--- |
| Logical OR | `a \| b` | `if (a \|\| b) doWork();` | [Boolean Logic](https://example.com/logic) |
| Regex Group | `foo\|bar` | `const re = /(foo\|bar)/;` | [Regular Expressions](https://example.com/regex) |
| Pipe Literal | `\|` alone | `echo "a\|b" \| wc -c` | [CLI Pipelines](https://example.com/cli) |
| Combined | `x \| y` with `[link]` | `test(\|data\|)` | [Data Spec](https://example.com/data) |

## Long Unbroken Words and URLs

Unbroken string testing horizontal container overflow and break-word CSS rules:

SupercalifragilisticexpialidociousAntidisestablishmentarianismPneumonoultramicroscopicsilicovolcanoconiosisislongunbrokenwordwithoutanyspacestotestoverflowbehaviorinmarkdownrenderers

Unbroken URL testing auto-linkification wrapping without viewport blowout:

https://example.com/api/v2/namespaces/default/deployments/production-cluster-internal-service-mesh-gateway-controller?filter=active&sort=descending&include_metadata=true&token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_session_nonce_long_unbroken_query_parameter_string

## Hard Line Breaks

Line terminating with two trailing spaces  
This line must render immediately below without an empty paragraph gap.

Line terminating with a backslash\
This line also renders directly below using backslash break syntax.

Standard continuous prose line
which should wrap normally under soft-break rules according to standard CommonMark.

## Reference Style Links and Images

Standard reference link: [CommonMark Specification Homepage][cm-spec].

Collapsed reference link: [CommonMark][].

Case-insensitive reference link: [Reference Test][CM-SPEC].

Reference style image:

![Markdown Logo Sample][md-logo]

[cm-spec]: https://spec.commonmark.org/ "CommonMark Specification"
[CommonMark]: https://commonmark.org
[md-logo]: https://commonmark.org/images/markdown-mark.png "Markdown Mark"

## Autolinks

Standard URI autolink: <https://github.com/github/cmark-gfm>

Email autolink: <support@example.com>

Autolink with query parameters: <https://example.org/search?q=gfm+tables&lang=en#results>

## Raw HTML Elements

Raw HTML details disclosure widget:

<details>
<summary>Click to inspect hidden diagnostic data</summary>
<p>This content is hidden by default and expanded on demand.</p>
</details>

Keyboard shortcut styling using kbd tags:
Press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd> to launch the command launcher.

Subscript tags:
Chemical compound formula: H<sub>2</sub>SO<sub>4</sub> and CO<sub>2</sub>.

Image tag with explicit inline attributes:
<img src="https://commonmark.org/images/markdown-mark.png" width="96" height="60" alt="Markdown Logo Scaled" />

Self-closing break tags:<br>First segment after break tag.<br>Second segment after break tag.

## HTML Sanitization and XSS Prevention

The following raw HTML snippets test DOM sanitizers (e.g. DOMPurify or sanitize-html). None of these scripts or handlers should execute:

Raw script injection attempt:
<script>alert(1)</script>

Image onerror attribute injection:
<img src="invalid-image-source.png" onerror="alert(1)">

Anchor javascript protocol scheme:
[Malicious Anchor Link](javascript:alert(1))

Iframe injection attempt:
<iframe src="javascript:alert(1)"></iframe>

Inline SVG onload handler:
<svg onload="alert(1)"></svg>

## Four Backtick Fences with Nested Three Backticks

````markdown
Inside a 4-backtick code fence, standard 3-backtick code fences are preserved verbatim:

```typescript
function greet(user: string): string {
  return `Hello, ${user}!`;
}
```

This ensures nested Markdown code blocks render without closing prematurely.
````

## Tilde Code Fences

~~~yaml
version: "3.8"
services:
  database:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: viewer_cache
    volumes:
      - db_data:/var/lib/postgresql/data
volumes:
  db_data:
~~~

## Indented Code Blocks

Below is an indented code block using 4 leading spaces without fence delimiters:

    // 4-space indented code block
    package main

    import "fmt"

    func main() {
        fmt.Println("Indented block executed")
    }

## Unknown Language Code Fence

```foobarlangcustom99
DEFINE RECORD {
    ID: 0x9942,
    FLAGS: [ENABLE_FAST_IO, STRICT_BOUNDS],
    EMIT: -> STDOUT
}
```

## Empty Code Blocks

Fenced block with zero lines:
```
```

Fenced block with language tag but zero lines:
```python
```

Tilde block with zero lines:
~~~
~~~

## Invalid LaTeX Syntax

The following inline and block math contains deliberate syntax errors to test graceful KaTeX error boundaries:

Inline syntax error missing closing bracket:
$\frac{1}{$

Unbalanced delimiters and unknown commands:
$\unknowncommand{foo}{bar$

Display math with mismatched environment tags:
$$
\begin{matrix}
1 & 2 \\
3 & 4
\end{invalid_environment}
$$

## Currency Dollar Signs Outside Math

Regular currency values should not be parsed as math spans:

The concert tickets cost $5 and $10 each.
The total budget rose from $1,000,000 to $2,500,000 in Q3.
He paid $50 for the book, $20 for shipping, and $5 in tax ($75 total).
Variables like $PATH and $HOME in bash scripts are shell variables, not math.

## Multiline Display Math Blocks

Display math block spanning multiple lines with matrices and systems:

$$
\begin{aligned}
\dot{x} &= \sigma(y - x) \\
\dot{y} &= x(\rho - z) - y \\
\dot{z} &= xy - \beta z
\end{aligned}
$$

Gaussian normal distribution probability density function:

$$
P(x) = \frac{1}{\sigma \sqrt{2\pi}} \exp\left( -\frac{1}{2}\left(\frac{x - \mu}{\sigma}\right)^{\!2} \right)
$$

## Multi-Paragraph Footnotes

Standard single footnote callouts[^simple-ref] and complex multi-paragraph footnotes[^complex-ref].

[^simple-ref]: A standard single-paragraph footnote definition.

[^complex-ref]: This is the first paragraph of an extended footnote reference.

    This is the second paragraph belonging to the same footnote reference.
    It is indented four spaces to preserve block container membership.

    > Even blockquotes can be nested inside multi-paragraph footnotes.
    > The quote continues under footnote scope.

    ```python
    # Code block inside multi-paragraph footnote
    def footnote_helper():
        return True
    ```

## Emoji Shortcodes

Inline shortcodes across categories:

:smile: :heart: :tada: :fire: :rocket: :warning: :white_check_mark: :bulb: :sparkles: :gear: :lock: :pencil: :package: :zap:

Mixed within text: The project build status is :white_check_mark: green and ready for :rocket: deployment.

## Unicode, RTL, and ZWJ Sequences

Bidirectional Arabic script (Right-to-Left):

النص العربي يجب أن يُعرض من اليمين إلى اليسار مع دعم التشكيل والخطوط المتصلة بشكل صحيح في واجهة القراءة.

Simplified Chinese script:

测试中文字符渲染与自动换行效果，验证标点符号挤压与中英文混排排版表现。

Zero Width Joiner (ZWJ) emoji sequences:

- Family sequence: 👨‍👩‍👧‍👦 (U+1F468 U+200D U+1F469 U+200D U+1F467 U+200D U+1F466)
- Woman technologist: 👩‍💻 (U+1F469 U+200D U+1F4BB)
- Rainbow flag: 🏳️‍🌈 (U+1F3F3 U+FE0F U+200D U+1F308)
- Polar bear: 🐻‍❄️ (U+1F43B U+200D U+2744 U+FE0F)

Combining diacritics and accented characters:

Z̨͑ͫ̓͑͌̀͜Aͥͥͥͮͥͭ͝Lͮ̉ͬͦͪ͠Gͭͦ̔̎ͫOͣͬ͑̄̌ͭ text testing vertical overflow containment.
Accents: café, mañana, naïve, façade, über, résumé, Ångström, Schrödinger.

## Invalid Mermaid Syntax

The following mermaid code block contains deliberately malformed diagram syntax to verify error boundary fallbacks:

```mermaid
graph TD
    A --> B
    B --- ??? Broken Token Error <<<
    --> Missing Source Node
    C[Unclosed Bracket
```

## Escaped Markdown Characters

Escaped characters that should render as literal glyphs rather than markup triggers:

\*This text is surrounded by escaped asterisks and is not italic\*

\_This text is surrounded by escaped underscores and is not italic\_

\*\*This text is surrounded by escaped double asterisks and is not bold\*\*

\[This is an escaped link bracket and should not become a hyperlink\](https://example.com)

\`This is not an inline code span\`

\# This is an escaped hash symbol at the start of a line, not a heading

\> This is an escaped greater-than symbol at the start of a line, not a quote

\- This is an escaped hyphen at the start of a line, not a list item

\+ This is an escaped plus symbol at the start of a line, not a list item

1\. This is an escaped period after a number, not an ordered list item

\~\~This is surrounded by escaped tildes and is not strikethrough\~\~

\$5 and \$10 escaped currency symbols

\\ This is an escaped literal backslash
