# web_search

Search the web. By default, Codexrev uses the Google Programmable Search JSON API, but the implementation is pluggable.

## Environment

The bundled implementation uses:

| Variable | Required | Description |
| --- | --- | --- |
| `GOOGLE_API_KEY` | yes | API key |
| `GOOGLE_CSE_ID` | yes | Custom Search Engine ID |

## Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | `string` | yes | Search query. |
| `num` | `number` | no | Number of results (max 10). Default 5. |

## Result

```ts
{
  results: Array<{ title: string; url: string; snippet: string }>,
}
```
