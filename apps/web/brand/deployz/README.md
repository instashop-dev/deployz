# Deployz brand icon

The canonical Deployz symbol is deployz-icon-master.svg. Never redraw or
independently modify small-size variants.

The symbol is the approved **01C** mark. All files below come from the
approved designer package (`deployz-brand-icons-v2-corrected`). No file was
redrawn, traced, or simplified.

## Files

| File | Source | Use |
| --- | --- | --- |
| `brand/deployz/deployz-icon-master.svg` | package master | Canonical source. The application does not serve it. |
| `src/components/deployz-brand.tsx` | master path data, `currentColor` fill | All in-app brand marks (`DeployzBrand`, `DeployzIcon`). |
| `src/app/icon.svg` | master path data; black fill, white fill for a dark browser theme | Browser tab icon (Next.js file convention). |
| `src/app/favicon.ico` | package `favicon.ico` (16 to 256 px) | Browser tab icon fallback. |
| `src/app/apple-icon.png` | package `apple-touch-icon.png` (180 px) | iOS home screen icon. |
| `public/brand/deployz/android-chrome-*.png` | package | Web manifest icons (`src/app/manifest.ts`). |
| `public/brand/deployz/maskable-icon-*.png` | package | Web manifest maskable icons. |
| `public/brand/deployz/deployz-icon.svg` | master path data, `currentColor` fill | Stable public URL of the symbol. |
| `public/brand/deployz/deployz-icon-512.png` | package `deployz-icon-512x512.png` | Stable public URL of the raster symbol for external services. |

Next.js adds the `<link>` tags for `favicon.ico`, `icon.svg`, `apple-icon.png`,
and the manifest. Do not set `metadata.icons` in a layout: Next.js then ignores
the icon files.

## Rules

1. Use `DeployzBrand` or `DeployzIcon` for each brand mark in the UI. Do not
   paste the SVG into a different component.
2. The symbol takes its color from the text color (`currentColor`). Do not add
   separate black and white logo branches.
3. Do not add a file to `public/brand/deployz` unless the application uses it.

## Drift protection

`apps/web/test/brand-assets.test.ts` runs with the unit tests. It fails when:

- a vector copy (component, `icon.svg`, `deployz-icon.svg`) has path data or a
  `viewBox` that is different from the master;
- a raster file is different from its SHA-256 value in
  `approved-checksums.json`;
- the master path data is different from `masterPathSha256`;
- `public/brand/deployz` contains a file that the test does not guard.

## How to change the symbol

Only do this when there is a new approved designer package.

1. Replace `deployz-icon-master.svg` and each file in the table with the
   files from the new package.
2. Copy the new path data into `deployz-brand.tsx`, `icon.svg`, and
   `deployz-icon.svg`. Change only the fill.
3. Update `approved-checksums.json` in the same pull request.
4. Make sure that `pnpm vitest run apps/web/test/brand-assets.test.ts` passes.
