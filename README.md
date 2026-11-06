# dev

Sets up a workspace around one code repository and keeps the tickets, docs, designs and
PRs around it in local files, so people and AI agents can gather what a task needs, do the
work and hand it over.

Not ready for use yet. The design is in [docs/design.md](docs/design.md).

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```

Tests use a temporary config folder and an example plugin in `test/fixtures/`, so they
never reach a real service. `DEV_EXTRA_PLUGINS` loads plugin modules from paths, for
developing plugins; they run with your credentials like any plugin.

## Licence

MIT
