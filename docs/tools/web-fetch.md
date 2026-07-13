# web_fetch

`web_fetch` performs a single HTTP GET and returns the body as Markdown-ish text.

```ts
web_fetch({ url: "https://example.com" })
```

## Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | `string` | yes | URL to fetch (http or https). |
| `maxBytes` | `number` | no | Limit the response size. Default 1 MiB. |

## Implementation notes

- Uses `undici` for high-throughput HTTP.
- HTML responses are converted to text via `html-to-text`.
- Non-200 responses yield `{ output: 'HTTP …', isError: true }`.

## Rate limits

There is **no built-in rate limit**. If you call this tool in a tight loop, respect the target site's `robots.txt` and consider an explicit `sleep` between calls.
