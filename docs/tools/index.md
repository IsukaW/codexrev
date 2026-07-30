# Built-in tools

Codexrev ships nine built-in tools:

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
| `ask_user` | Pause execution and ask the user a clarification question. |

Each is described in detail on its own page:

- [shell.md](shell.md)
- [file_system.md](file_system.md)
- [web_fetch.md](web-fetch.md)
- [web_search.md](web-search.md)
- [mcp_server.md](mcp-server.md)
- [memory.md](memory.md)
- [multi_file.md](multi-file.md)

### `ask_user` tool

The `ask_user` tool lets the model pause execution and ask the user a clarification question. It is available in all modes and is especially important in the pipeline, where ambiguous requests can be resolved before implementation begins.

**Parameters:**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `question` | `string` | yes | The question to ask the user. |
| `suggestions` | `string[]` | no | Quick-select answer options shown in the TUI. |
| `context` | `string` | no | Additional context displayed alongside the question. |

When the model calls this tool, the TUI shows a bordered prompt with the question, optional suggestions (selectable with ↑↓ + Enter), and a free-form text input (Tab to toggle between suggestions and custom input when suggestions are present). The user's answer is returned to the model as a tool result, and execution resumes.

To inspect them programmatically:

```ts
import { listTools } from 'codexrev';
listTools().forEach((t) => console.log(t.name, '—', t.description));
```
