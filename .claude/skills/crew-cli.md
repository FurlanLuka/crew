---
name: crew-cli
description: >
  Every TUI feature must have a CLI equivalent. CLI-only features don't need TUI.
  Reference for which CLI commands exist and how to add new ones.
---

# crew CLI parity rule

Every TUI feature **must** have a CLI equivalent. CLI-only features don't need TUI.

When adding a new TUI feature, wire it up as a CLI command too. The pattern:

```go
case "mycommand":
    if len(os.Args) > 2 {
        cmdMyCommand() // CLI subcommands
        return
    }
    runTUI(mypackage.NewView())
```

## Existing CLI commands

All operations are available via CLI. See `crew help --json` for the full tree.

### CRUD operations

| Operation | CLI |
|---|---|
| Add project | `crew add project <name> <path>` |
| Remove project | `crew rm project <name>` |
| Create workspace | `crew add workspace <name>` |
| Add project to workspace | `crew add workspace <ws> <proj> --role=<r>` |
| Remove project from workspace | `crew rm workspace <ws> <proj>` |
| Remove workspace | `crew rm <ws>` |

### Registry

| Operation | CLI |
|---|---|
| Install | `crew registry install [<name> \| --all]` |
| Remove | `crew registry rm <name>` |
| Update | `crew registry update [<name> \| --all]` |

### Settings

| Operation | CLI |
|---|---|
| Show | `crew config show` |
| Set | `crew config set <key> <value>` |

### Profile

| Operation | CLI |
|---|---|
| Install | `crew profile install` |
| Update | `crew profile update` |
| Remove | `crew profile rm` |
| Status | `crew profile status` |

### Notifications

| Operation | CLI |
|---|---|
| Setup | `crew notify setup [<topic>]` |
| Test | `crew notify test` |
| Remove | `crew notify rm` |
