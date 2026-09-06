# Septa / Tria

A standalone kaleidoscopic audiovisual instrument built around nested seven-fold and three-fold physical mirror geometry.

## Download

Open the repository's **Releases** page and choose:

- Windows: the portable `.exe`
- macOS: the universal `.dmg` or `.zip` (Apple silicon and Intel)

The first release is unsigned. Windows SmartScreen or macOS Gatekeeper may therefore ask for confirmation before opening it.

## Use

- Click to create a snowflake event.
- Drag original flakes to reshape their reflected field.
- Load one or several WAV, MP3, or OGG samples.
- Select a scale and adjust the shared rotational speed.
- Use presentation mode for a clean fullscreen projection view.

Audio remains entirely local to the application. Loaded samples are not uploaded.

## Development

Requires Node.js 22 and pnpm 10.

```bash
pnpm install
pnpm desktop:build
pnpm desktop:package
```

Creating a tag such as `v1.0.0` runs the GitHub workflow, builds Windows and universal macOS packages, and publishes them to GitHub Releases.
