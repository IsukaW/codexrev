# Built-in tools

Codexrev ships eight built-in tools:

| Name | Description |
| --- | --- |
| `shell` | Run a shell command in a sandboxed environment. |
| `read_file` | Read the contents of one or more files. |
| `write_file` | Create or overwrite a file. |
| `edit` | Apply a patch to a file. |
| `glob` | List files matching a glob. |
| `grep` | Search files for a regex. |
| `web_fetch` | GET a URL and return the body as text. |
| `web_search` | Search the web (Google by default). |

Each is described in detail on its own page:

- [shell.md](shell.md)
- [file_system.md](file_system.md)
- [web_fetch.md](web-fetch.md)
- [web_search.md](web-search.md)
- [mcp_server.md](mcp-server.md)
- [memory.md](memory.md)
- [multi_file.md](multi-file.md)

To inspect them programmatically:

```ts
import { listTools } from 'codexrev';
listTools().forEach((t) => console.log(t.name, '—', t.description));
```
