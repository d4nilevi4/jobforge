# Writing templates

A template controls layout; the profile supplies identity and the application supplies standard resume/cover content. Current built-ins are `classic`, `compact`, `modern` (resumes), and `letter` (cover). Read the [agent guide](agent-guide.md) for content rules and [OpenAPI](../schema/openapi.json) for the HTTP contract.

## Syntax

`template.html` is a complete HTML document with a UTF-8 charset. The engine is logic-less and HTML-escapes values by default:

| Syntax | Meaning |
| --- | --- |
| `{{path.to.value}}` | Escaped value; unknown paths render empty. |
| `{{{path}}}` | Raw value; use only for deliberately trusted HTML. |
| `{{.}}` | Current loop item, e.g. a bullet string. |
| `{{#each resume.experience}}...{{/each}}` | Iterate an array; item fields become the current scope. Outer scopes remain available. |
| `{{@index}}`, `{{@first}}`, `{{@last}}` | Zero-based index and first/last booleans inside a loop. |
| `{{#if resume.summary}}...{{else}}...{{/if}}` | Conditional; missing, empty string/array, false, null, and zero are false. |
| `{{labels.experience}}` | Localized section label. |

Partials (`{{> name}}`) are rejected; expressions and arbitrary helpers are not supported. Match every block's closing tag. Do not use raw interpolation for candidate text. Limits are 12 nested blocks, 200,000 evaluation steps, and 2 MB rendered output; simplify repeated blocks if a limit fails.

## Render context

| Variable | Value |
| --- | --- |
| `identity.name` | Name resolved from `name_localized[lang]`, falling back to profile name. |
| `identity.email`, `identity.phone`, `identity.location` | Profile contact fields, falling back to empty strings. |
| `identity.availability` | Resolved string: requested language, English, first available entry, or empty. |
| `identity.links` | Flat array of `{label,url,display}`; display removes the URL scheme and trailing slashes. URLs accept http/https/mailto/tel with no whitespace/control characters; invalid links become empty. It is nested under identity. Project links use the same sanitization. |
| `lang` | Resume/cover document language, then supplied language, then `en`. |
| `labels` | Section/contact/greeting/closing labels: English defaults and English metadata, then requested-language built-in defaults (en/ru) and metadata overrides for that language. Other languages use English plus their metadata overrides. |
| `paper` | Metadata value `letter` or `a4`; the template must still set its CSS page size. |
| `resume` | Standard resume content, when supplied for this render. |
| `cover` | Standard cover content, when supplied for this render. |
| `paragraphs` | Cover text split at blank lines into an array of strings. |

There is no `summary_html` variable in the current implementation. Render `{{resume.summary}}` as text with `white-space: pre-line`. In normal application renders only the document being rendered is supplied; do not make a resume depend on cover fields or vice versa.

```html
<!doctype html>
<html lang="{{lang}}">
<head><meta charset="utf-8"><title>{{identity.name}}</title>
<style>
@page { size: A4; margin: 14mm; }
body { margin: 0; font: 10pt/1.25 "Liberation Sans", "Noto Sans", Arial, sans-serif; }
h2 { break-after: avoid; }
.entry, li { break-inside: avoid; }
p { orphans: 2; widows: 2; }
</style></head>
<body>
<h1>{{identity.name}}</h1><p>{{resume.headline}}</p>
{{#if resume.summary}}<p>{{resume.summary}}</p>{{/if}}
{{#each resume.experience}}
<section class="entry"><h2>{{company}}</h2><p>{{title}} · {{dates}}</p>
<ul>{{#each bullets}}<li>{{.}}</li>{{/each}}</ul></section>
{{/each}}
{{#each identity.links}}<p><a href="{{url}}">{{label}}: {{display}}</a></p>{{/each}}
</body></html>
```

## Metadata and content

A built-in folder contains `meta.json`, `template.html`, and `sample.json`. Built-ins also provide `sample.ru.json` as a useful manual fixture; the loader uses `sample.json` for API previews by default. Samples have `{profile_identity, resume, cover}`; the server builds the actual context from them. Use only fictional Alex Example data and example.com URLs.

| `meta.json` field | Meaning |
| --- | --- |
| `id` | Built-in folder name, or `custom-` prefixed slug for API templates. |
| `name`, `description` | Human-readable strings. |
| `kind` | `resume` or `cover`. |
| `version` | Integer version; use positive increasing versions for releases. API custom writes stamp this automatically. |
| `paper` | `letter` or `a4`; keep CSS in agreement. |
| `max_pages` | Positive integer, enforced when applications render. |
| `languages` | Array of supported language codes; declare only languages the layout and labels handle. |
| `labels` | Object of language maps, e.g. `{"en":{"experience":"Experience"},"ru":{}}`; empty maps use defaults. |

Every resume uses [content.schema.json](../schema/content.schema.json): `schema_version`, `language`, `headline`, optional `summary`, `experience[]` (`company,title,dates,location?,bullets[]`), `projects[]` (`title,tech?,link?,link_label?,bullets[]`), `skills[]` (`label,items` string), `education[]` (`institution,degree,years`), and optional `extra` object. Headline, experience, and skills are required. Profile skill items are arrays; resume skill items are strings. Cover uses [cover.schema.json](../schema/cover.schema.json): nonempty `text`, optional `language` and `schema_version`. Send version 1 explicitly.

Names, contacts, links, and availability belong in profile identity, never content. `extra` is available to custom layouts but is not fact-guarded; it must still contain verified facts. Templates cannot redefine the content schema.

## Print and ATS checks

Set `@page` size and margins explicitly; Chrome does not infer them from `meta.paper`. Use `break-inside: avoid` for individual entries and `break-after: avoid` for headings; keeping a whole long section unbreakable can create overflow. Test with long names, URLs, and Cyrillic text. Use a Linux font stack such as `"Liberation Sans", "Noto Sans", Arial, sans-serif`; the Docker image includes Liberation and Noto fonts. Avoid remote fonts/assets so rendering remains repeatable.

Keep the reading order single-column, use real text and semantic headings, preserve selectable text, and use real `<a href>` links. Do not use tables for layout, text rendered as images, or icons in place of contact labels. Inspect extracted/copied PDF text as well as appearance. Maintain readable font sizes; shorten content before compressing it excessively. PDF rendering blocks scripts and remote/local asset loads; inline CSS and data images/fonts are supported. HTML previews are sandboxed with a restrictive Content-Security-Policy.

## Fork, preview, and publish

With origin in `BASE_URL` and a suitable token in `TOKEN`, fork a built-in:

```sh
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary '{"id":"custom-clean"}' "$BASE_URL/api/v1/templates/classic/fork"
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/v1/templates/custom-clean"
```

Edit `{meta,source}` in `template.json` and PUT the whole object to `/api/v1/templates/custom-clean`. Each save appends a custom version; the server overrides metadata id/version. Custom ids match `^custom-[a-z0-9][a-z0-9-]{0,56}$`. Deletion fails while tracks or applications reference the template.

```sh
curl -sS -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @template.json "$BASE_URL/api/v1/templates/custom-clean"
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary '{}' -D preview.headers -o preview.pdf "$BASE_URL/api/v1/templates/custom-clean/preview"
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @preview.json -o preview.html "$BASE_URL/api/v1/templates/custom-clean/preview?format=html"
```

Preview needs `read`, accepts `{content?,lang?,cover?}`, and uses sample content when omitted. The saved profile identity wins over sample identity if present. Use `?version=1` for an available version. Preview does schema validation but does not run the fact guard. A PDF preview reports `X-Pages` and, on overflow, `X-Page-Overflow: true`; it does not reject overflow. Use `/check` for application fact/page enforcement. Test both languages and representative long content; inspect PDFs and the Templates preview in the UI.

To propose a built-in, copy source and metadata into a new `templates/builtin/<id>/` folder, set matching id and initial version, and add English and Russian sample fixtures. Run the relevant engine/render/template tests with Chrome and include preview evidence in the pull request. Built-ins are read-only through HTTP. Record new built-ins and version bumps in CHANGELOG. Existing application PDFs are retained, but the loader only retains the current on-disk built-in version; preserve old source in release history and consider historical-version requirements before changing a built-in.
