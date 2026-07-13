# Uninstall

```bash
npm uninstall -g codexrev
rm -rf ~/.codexrev
```

The first command removes the CLI. The second removes all configuration, checkpoints, extensions, and memory files.

If you installed via `apt`/`brew`/etc., use the package manager's own uninstaller:

```bash
# Homebrew
brew uninstall codexrev

# Apt
sudo apt remove codexrev && sudo apt autoremove
```

To keep your config but drop the binary:

```bash
which codexrev
# then remove that single file
```

Codexrev does not install system services, cron jobs, or kernel extensions — nothing else needs cleanup.
